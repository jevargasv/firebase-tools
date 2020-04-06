"use strict";

const os = require("os");
const path = require("path");
const _ = require("lodash");

const api = require("./api");
const utils = require("./utils");

const EXPORTED_JSON_KEYS = [
  "localId",
  "email",
  "emailVerified",
  "passwordHash",
  "salt",
  "displayName",
  "photoUrl",
  "lastLoginAt",
  "createdAt",
  "phoneNumber",
  "disabled",
];
const EXPORTED_JSON_KEYS_RENAMING = {
  lastLoginAt: "lastSignedInAt",
};
const EXPORTED_PROVIDER_USER_INFO_KEYS = [
  "providerId",
  "rawId",
  "email",
  "displayName",
  "photoUrl",
];
const PROVIDER_ID_INDEX_MAP = {
  "google.com": 7,
  "facebook.com": 11,
  "twitter.com": 15,
  "github.com": 19,
};

const _escapeComma = function(str) {
  if (str.indexOf(",") !== -1) {
    // Encapsulate the string with quotes if it contains a comma.
    return `"${str}"`;
  }
  return str;
};

const _convertToNormalBase64 = function(data) {
  return data.replace(/_/g, "/").replace(/-/g, "+");
};

const _addProviderUserInfo = function(providerInfo, arr, startPos) {
  arr[startPos] = providerInfo.rawId;
  arr[startPos + 1] = providerInfo.email || "";
  arr[startPos + 2] = _escapeComma(providerInfo.displayName || "");
  arr[startPos + 3] = providerInfo.photoUrl || "";
};

const _transUserToArray = function(user) {
  const arr = Array(27).fill("");
  arr[0] = user.localId;
  arr[1] = user.email || "";
  arr[2] = user.emailVerified || false;
  arr[3] = _convertToNormalBase64(user.passwordHash || "");
  arr[4] = _convertToNormalBase64(user.salt || "");
  arr[5] = _escapeComma(user.displayName || "");
  arr[6] = user.photoUrl || "";
  for (let i = 0; i < (!user.providerUserInfo ? 0 : user.providerUserInfo.length); i++) {
    const providerInfo = user.providerUserInfo[i];
    if (providerInfo && PROVIDER_ID_INDEX_MAP[providerInfo.providerId]) {
      _addProviderUserInfo(providerInfo, arr, PROVIDER_ID_INDEX_MAP[providerInfo.providerId]);
    }
  }
  arr[23] = user.createdAt;
  arr[24] = user.lastLoginAt;
  arr[25] = user.phoneNumber;
  arr[26] = user.disabled;
  return arr;
};

const _transUserJson = function(user) {
  const newUser = {};
  _.each(_.pick(user, EXPORTED_JSON_KEYS), function(value, key) {
    const newKey = EXPORTED_JSON_KEYS_RENAMING[key] || key;
    newUser[newKey] = value;
  });
  if (newUser.passwordHash) {
    newUser.passwordHash = _convertToNormalBase64(newUser.passwordHash);
  }
  if (newUser.salt) {
    newUser.salt = _convertToNormalBase64(newUser.salt);
  }
  if (user.providerUserInfo) {
    newUser.providerUserInfo = [];
    user.providerUserInfo.forEach(function(providerInfo) {
      if (!_.includes(Object.keys(PROVIDER_ID_INDEX_MAP), providerInfo.providerId)) {
        return;
      }
      newUser.providerUserInfo.push(_.pick(providerInfo, EXPORTED_PROVIDER_USER_INFO_KEYS));
    });
  }
  return newUser;
};

const validateOptions = function(options, fileName) {
  const exportOptions = {};
  if (fileName === undefined) {
    return utils.reject("Must specify data file", { exit: 1 });
  }
  const extName = path.extname(fileName.toLowerCase());
  if (extName === ".csv") {
    exportOptions.format = "csv";
  } else if (extName === ".json") {
    exportOptions.format = "json";
  } else if (options.format) {
    const format = options.format.toLowerCase();
    if (format === "csv" || format === "json") {
      exportOptions.format = format;
    } else {
      return utils.reject("Unsupported data file format, should be csv or json", { exit: 1 });
    }
  } else {
    return utils.reject("Please specify data file format in file name, or use `format` parameter", {
      exit: 1,
    });
  }
  return exportOptions;
};

const _createWriteUsersToFile = function() {
  let jsonSep = "";
  return function(userList, format, writeStream) {
    userList.map(function(user) {
      if (user.passwordHash && user.version !== 0) {
        // Password isn't hashed by default Scrypt.
        delete user.passwordHash;
        delete user.salt;
      }
      if (format === "csv") {
        writeStream.write(_transUserToArray(user).join(",") + "," + os.EOL, "utf8");
      } else {
        writeStream.write(jsonSep + JSON.stringify(_transUserJson(user), null, 2), "utf8");
        jsonSep = "," + os.EOL;
      }
    });
  };
};

var serialExportUsers = function(projectId, options) {
  if (!options.writeUsersToFile) {
    options.writeUsersToFile = _createWriteUsersToFile();
  }
  const postBody = {
    targetProjectId: projectId,
    maxResults: options.batchSize,
  };
  if (options.nextPageToken) {
    postBody.nextPageToken = options.nextPageToken;
  }
  if (!options.timeoutRetryCount) {
    options.timeoutRetryCount = 0;
  }
  return api
    .request("POST", "/identitytoolkit/v3/relyingparty/downloadAccount", {
      auth: true,
      json: true,
      data: postBody,
      origin: api.googleOrigin,
    })
    .then(function(ret) {
      options.timeoutRetryCount = 0;
      const userList = ret.body.users;
      if (userList && userList.length > 0) {
        options.writeUsersToFile(userList, options.format, options.writeStream);
        utils.logSuccess("Exported " + userList.length + " account(s) successfully.");
        // The identitytoolkit API do not return a nextPageToken value
        // consistently when the last page is reached
        if (!ret.body.nextPageToken) {
          return;
        }
        options.nextPageToken = ret.body.nextPageToken;
        return serialExportUsers(projectId, options);
      }
    })
    .catch((err) => {
      // Calling again in case of error timedout so that script won't exit
      if (err.original.code === "ETIMEDOUT") {
        options.timeoutRetryCount++;
        if (options.timeoutRetryCount > 5) {
          return err;
        }
        return serialExportUsers(projectId, options);
      }
    });
};

const accountExporter = {
  validateOptions: validateOptions,
  serialExportUsers: serialExportUsers,
};

module.exports = accountExporter;
