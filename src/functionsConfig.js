"use strict";

const _ = require("lodash");
const clc = require("cli-color");

const api = require("./api");
const ensureApiEnabled = require("./ensureApiEnabled").ensure;
const { FirebaseError } = require("./error");
const getProjectId = require("./getProjectId");
const runtimeconfig = require("./gcp/runtimeconfig");

exports.RESERVED_NAMESPACES = ["firebase"];

function _keyToIds(key) {
  const keyParts = key.split(".");
  const variable = keyParts.slice(1).join("/");
  return {
    config: keyParts[0],
    variable: variable,
  };
}

function _setVariable(projectId, configId, varPath, val) {
  if (configId === "" || varPath === "") {
    const msg = "Invalid argument, each config value must have a 2-part key (e.g. foo.bar).";
    throw new FirebaseError(msg);
  }
  return runtimeconfig.variables.set(projectId, configId, varPath, val);
}

function _isReservedNamespace(id) {
  return _.some(exports.RESERVED_NAMESPACES, (reserved) => {
    return id.config.toLowerCase().startsWith(reserved);
  });
}

exports.ensureApi = function(options) {
  const projectId = getProjectId(options);
  return ensureApiEnabled(projectId, "runtimeconfig.googleapis.com", "runtimeconfig", true);
};

exports.varNameToIds = function(varName) {
  return {
    config: varName.match(new RegExp("/configs/(.+)/variables/"))[1],
    variable: varName.match(new RegExp("/variables/(.+)"))[1],
  };
};

exports.idsToVarName = function(projectId, configId, varId) {
  return _.join(["projects", projectId, "configs", configId, "variables", varId], "/");
};

exports.getAppEngineLocation = function(config) {
  let appEngineLocation = config.locationId;
  if (appEngineLocation && appEngineLocation.match(/[^\d]$/)) {
    // For some regions, such as us-central1, the locationId has the trailing digit cut off
    appEngineLocation = appEngineLocation + "1";
  }
  return appEngineLocation || "us-central1";
};

exports.getFirebaseConfig = function(options) {
  const projectId = getProjectId(options, false);
  return api
    .request("GET", "/v1beta1/projects/" + projectId + "/adminSdkConfig", {
      auth: true,
      origin: api.firebaseApiOrigin,
    })
    .then((response) => response.body);
};

// If you make changes to this function, run "node scripts/test-functions-config.js"
// to ensure that nothing broke.
exports.setVariablesRecursive = function(projectId, configId, varPath, val) {
  let parsed = val;
  if (_.isString(val)) {
    try {
      // Only attempt to parse 'val' if it is a String (takes care of unparsed JSON, numbers, quoted string, etc.)
      parsed = JSON.parse(val);
    } catch (e) {
      // 'val' is just a String
    }
  }
  // If 'parsed' is object, call again
  if (_.isPlainObject(parsed)) {
    return Promise.all(
      _.map(parsed, function(item, key) {
        const newVarPath = varPath ? _.join([varPath, key], "/") : key;
        return exports.setVariablesRecursive(projectId, configId, newVarPath, item);
      })
    );
  }

  // 'val' wasn't more JSON, i.e. is a leaf node; set and return
  return _setVariable(projectId, configId, varPath, val);
};

exports.materializeConfig = function(configName, output) {
  const _materializeVariable = function(varName) {
    return runtimeconfig.variables.get(varName).then(function(variable) {
      const id = exports.varNameToIds(variable.name);
      const key = id.config + "." + id.variable.split("/").join(".");
      _.set(output, key, variable.text);
    });
  };

  const _traverseVariables = function(variables) {
    return Promise.all(
      _.map(variables, function(variable) {
        return _materializeVariable(variable.name);
      })
    );
  };

  return runtimeconfig.variables
    .list(configName)
    .then(function(variables) {
      return _traverseVariables(variables);
    })
    .then(function() {
      return output;
    });
};

exports.materializeAll = function(projectId) {
  const output = {};
  return runtimeconfig.configs.list(projectId).then(function(configs) {
    return Promise.all(
      _.map(configs, function(config) {
        if (config.name.match(new RegExp("configs/firebase"))) {
          // ignore firebase config
          return Promise.resolve();
        }
        return exports.materializeConfig(config.name, output);
      })
    ).then(function() {
      return output;
    });
  });
};

exports.parseSetArgs = function(args) {
  const parsed = [];
  _.forEach(args, function(arg) {
    const parts = arg.split("=");
    const key = parts[0];
    if (parts.length < 2) {
      throw new FirebaseError("Invalid argument " + clc.bold(arg) + ", must be in key=val format");
    }
    if (/[A-Z]/.test(key)) {
      throw new FirebaseError("Invalid config name " + clc.bold(key) + ", cannot use upper case.");
    }

    const id = _keyToIds(key);
    if (_isReservedNamespace(id)) {
      throw new FirebaseError("Cannot set to reserved namespace " + clc.bold(id.config));
    }

    const val = parts.slice(1).join("="); // So that someone can have '=' within a variable value
    parsed.push({
      configId: id.config,
      varId: id.variable,
      val: val,
    });
  });
  return parsed;
};

exports.parseUnsetArgs = function(args) {
  const parsed = [];
  let splitArgs = [];
  _.forEach(args, function(arg) {
    splitArgs = _.union(splitArgs, arg.split(","));
  });

  _.forEach(splitArgs, function(key) {
    const id = _keyToIds(key);
    if (_isReservedNamespace(id)) {
      throw new FirebaseError("Cannot unset reserved namespace " + clc.bold(id.config));
    }

    parsed.push({
      configId: id.config,
      varId: id.variable,
    });
  });
  return parsed;
};
