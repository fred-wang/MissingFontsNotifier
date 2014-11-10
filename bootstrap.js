/* -*- Mode: Javascript; tab-width: 2; indent-tabs-mode:nil; -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

const kIcon = "chrome://missingfontsnotifier/skin/notification-48.png";
const kNotified = 0;
const kProcessed = 1;
const kIgnored = 2;

Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Downloads.jsm");
Cu.import("resource://gre/modules/osfile.jsm")
Cu.import("resource://gre/modules/Task.jsm");

let gMissingFontsNotifier = {

    // This will contain the JSON file at chrome/content/fonts.json
    mFontData: null,

    // These two values are given by the "missingfontsnotifier.packagekitnames"
    // and "missingfontsnotifier.downloadfromserver" preferences and control
    // which information to use from chrome/content/fonts.json.
    // The first one gives the PackageKit names to use ("debian", "fedora"...).
    // The second one indicates whether we fallback to a download from a server.
    mPackageKitNames: null,
    mDownloadFromServer: null,

    // This is an object containing pair "script-name: state" for the script
    // names we already handled. The state can be kNotified (displayed in the
    // alert/dialog windows), kProcessed (the user clicked "OK" in the dialog)
    // or kIgnored (the user clicked "Ignore" in the dialog, perhaps in a
    // previous session).
    mScripts: null,

    // These are reference to our custom alert and dialog windows, to ensure
    // that we only open one at a time.
    mAlertWindow: null,
    mDialogWindow: null,

    // Some variables to handle PackageKit transactions.
    mPackageKitService: null,
    mPackagesToDownload: null,

    closeAllWindowsOfType: function(aType) {
        let windows = Cc["@mozilla.org/appshell/window-mediator;1"]
            .getService(Ci.nsIWindowMediator).getEnumerator(aType);
        while (windows.hasMoreElements()) {
            windows.getNext().close();
        }
    },

    init: function() {
        // Close all windows.
        this.closeAllWindowsOfType("alert:missingfontsnotifier");
        this.closeAllWindowsOfType("dialog:missingfontsnotifier");
        this.mAlertWindow = null;
        this.mDialogWindow = null;

        // Initialize the preferences.
        this.mScripts = {};
        this.mPackageKitNames = null;
        this.mDownloadFromServer = true;
        this.loadPreferences();
        try {
            let service = Cc["@mozilla.org/packagekit-service;1"].
                getService(Ci.nsIPackageKitService);
        } catch(e) {
            // If nsIPackageKitService is not available, never use PackageKit.
            this.mPackageKitNames = null;
        }

        // Initialize the PackageKit members.
        this.mPackageKitService = null;
        this.mPackagesToDownload = [];

        Services.obs.addObserver(this, "font-needed", false);
    },

    cleanup: function() {
        this.closeAllWindowsOfType("alert:missingfontsnotifier");
        this.closeAllWindowsOfType("dialog:missingfontsnotifier");
        Services.obs.removeObserver(this, "font-needed");
        this.savePreferences();
    },

    observe: function(aSubject, aTopic, aData) {
        switch (aTopic) {
          case "font-needed":
            this.fontNeeded(aData);
            break;
          case "alertclickcallback":
            this.mAlertWindow.close();
            this.mAlertWindow = null;
            this.alertClickCallback(aData);
            break;
          case "alertfinished":
            this.mAlertWindow = null;
            break;
          case "dialogfinished":
            this.dialogFinished(aData);
            this.mDialogWindow = null;
            break;
          case "packagekit-install":
            // TODO: check error message.

            // Try and install possibly deferred packages.
            this.packageKitInstall();
            break;
          default:
            break;
        }
    },

    getString: function(aName) {
        // We randomize to workaround bug 918033.
        let stringBundle = Services.strings.createBundle("chrome://missingfontsnotifier/locale/strings.properties?" + Math.random());
        this.getString = function(aName) {
            return stringBundle.GetStringFromName(aName);
        }
        return this.getString(aName);
    },

    loadFontData: function(aCallback) {
        if (this.mFontData !== null) {
            aCallback();
            return;
        }
        let ios = Cc["@mozilla.org/network/io-service;1"].
            getService(Ci.nsIIOService);
        let channel = ios.newChannel("chrome://missingfontsnotifier/content/fonts.json", null, null);
        NetUtil.asyncFetch(channel, function(aInputStream, aResult) {
            if (Components.isSuccessCode(aResult)) {
                let is = Cc["@mozilla.org/scriptableinputstream;1"].
                    createInstance(Ci.nsIScriptableInputStream);
                is.init(aInputStream);
                let json = is.read(aInputStream.available());
                try {
                    gMissingFontsNotifier.mFontData = JSON.parse(json) || null;
                } catch(e) {
                    gMissingFontsNotifier.mFontData = null;
                }
                if (!gMissingFontsNotifier.mFontData) {
                    console.error("Failed to download font data!");
                    gMissingFontsNotifier.mFontData = {};
                }
                aCallback();
            }
        });
    },

    getMissingScripts: function() {
        let missingScripts = [];
        for (let name in this.mScripts) {
            if (this.mScripts[name] == kNotified) {
                missingScripts.push(this.getString(name));
            }
        }
        return missingScripts;
    },

    loadPreferences: function() {
        let preferences = Cc["@mozilla.org/preferences-service;1"].
            getService(Ci.nsIPrefService).getBranch("missingfontsnotifier.");
        if (preferences.prefHasUserValue("ignored_scripts")) {
            let ignoredScripts = preferences.
                getCharPref("ignored_scripts").split(",");
            ignoredScripts.forEach(function(aElement, aIndex, aArray) {
                if (aElement != "") {
                    this.mScripts[aElement] = kIgnored;
                }
            }, this);
        }
        if (preferences.prefHasUserValue("packagekitnames")) {
            this.mPackageKitNames = preferences.getCharPref("packagekitnames");
        }
        if (preferences.prefHasUserValue("downloadfromserver")) {
            this.mDownloadFromServer = preferences.getBoolPref("downloadfromserver");
        }
    },

    savePreferences: function() {
        let ignoredScripts = "";
        for (let name in this.mScripts) {
            if (this.mScripts[name] == kIgnored) {
                ignoredScripts += name + ",";
            }
        }
        Cc["@mozilla.org/preferences-service;1"].
            getService(Ci.nsIPrefService).getBranch("missingfontsnotifier.").
            setCharPref("ignored_scripts", ignoredScripts);
    },

    fontNeeded: function(aData) {
        let hasNewScripts = false;
        let scriptList = aData.split(",");
        scriptList.forEach(function(aElement, aIndex, aArray) {
            if (aElement == "") {
                // skip empty tag
            } else if (!(aElement in this.mScripts)) {
                // new script
                this.mScripts[aElement] = kNotified;
                hasNewScripts = true;
            }
        }, this);
        if (!hasNewScripts) {
            return;
        }
        if (this.mDialogWindow) {
            this.mDialogWindow.
                updateMissingScripts(this.getMissingScripts());
        } else if (!this.mAlertWindow) {
            // The standard nsIAlertsService service hides the notification
            // relatively quickly. The user is unlikely to have a second chance
            // to see the alert because the backend code only sends one
            // "font-needed" per script during a browser session. Hence we
            // reimplement our own notification alert.
            this.mAlertWindow =
                Cc["@mozilla.org/embedcomp/window-watcher;1"].
                getService(Ci.nsIWindowWatcher).
                openWindow(null,
                           "chrome://missingfontsnotifier/content/alert.xul",
                           "missingfontsnotifier_alert",
                           "chrome,titlebar=no,popup=yes", null);
            this.mAlertWindow.arguments =
                [kIcon,
                 this.getString("notificationTitle"),
                 this.getString("couldNotDisplayChar"),
                 true, null, this];
        }
    },

    alertClickCallback: function(aData) {
        if (!this.mDialogWindow) {
            this.mDialogWindow =
                Cc["@mozilla.org/embedcomp/window-watcher;1"].
                getService(Ci.nsIWindowWatcher).
                openWindow(null,
                           "chrome://missingfontsnotifier/content/dialog.xul",
                           "missingfontsnotifier_dialog",
                           "chrome,centerscreen,dialog,minimizable=no",
                           null);
            this.mDialogWindow.arguments =
                [this.getMissingScripts(), this];
        }
    },

    dialogFinished: function(aUserChoice) {
        let name;
        if (aUserChoice == "cancel") {
            return;
        }
        switch (aUserChoice) {
          case "alwaysignore":
            for (name in this.mScripts) {
                this.mScripts[name] = kIgnored;
            }
            this.savePreferences();
            break;
          case "accept":
            let scriptsToProcess = [];
            for (name in this.mScripts) {
                if (this.mScripts[name] == kNotified) {
                    this.mScripts[name] = kProcessed;
                    scriptsToProcess.push(name);
                }
            }
            this.loadFontData(function() {
                gMissingFontsNotifier.processScripts(scriptsToProcess);
            });
            break;
          default: // "cancel"
            break;
        }
    },

    showAlertNotification: function(aMessage) {
        Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService).
            showAlertNotification(kIcon,
                                  this.getString("notificationTitle"),
                                  aMessage,
                                  false, "", null, "");
    },

    processScripts: function(aScriptsToProcess) {
        let name, data;
        let noFontsAvailable = [];
        while (aScriptsToProcess.length) {
            name = aScriptsToProcess.pop();
            if (name in this.mFontData) {
                data = this.mFontData[name];
                if (this.mPackageKitNames && this.mPackageKitNames in data) {
                    this.mPackagesToDownload.push(data[this.mPackageKitNames]);
                    continue;
                } else if (this.mDownloadFromServer && data.download) {
                    this.downloadFrom(data.download);
                    continue;
                }
            }
            noFontsAvailable.push(this.getString(name));
        }
        this.packageKitInstall();
        if (noFontsAvailable.length) {
            this.showAlertNotification(this.getString("noFontsAvailable") +
                                       " " + noFontsAvailable);
        }
    },

    packageKitInstall: function() {
        if (this.mPackagesToDownload.length == 0) {
            // Nothing to install
            return;
        }
        if (!this.mPackageKitService) {
            // Start a new packagekit transaction.
            this.mPackageKitService =
                Cc["@mozilla.org/packagekit-service;1"].
                getService(Ci.nsIPackageKitService);
            let packages = Cc["@mozilla.org/array;1"].
                createInstance(Ci.nsIMutableArray);
            this.mPackagesDownload.forEach(function(aPackage) {
                let p = Cc["@mozilla.org/supports-string;1"].
                    createInstance(Ci.nsISupportsString);
                p.data = aPackage;
                packages.appendElement(p, false);
            });
            packageKitService.installPackages(packageKitService.
                                              PK_INSTALL_PACKAGE_NAMES,
                                              packages, this);
        }
        // else a packagekit transaction is already in progress, the
        // files in this.mPackagesDownload will be downloaded when the current
        // transaction completes.
    },

    downloadFrom: function(aURI) {
        Task.spawn(function () {
            let list = yield Downloads.getList(Downloads.ALL);
            let temporaryDirectory;
            try {
                temporaryDirectory = OS.Path.join(OS.Constants.Path.tmpDir,
                                                  "MissingFontsNotifier");
                yield OS.File.makeDir(temporaryDirectory);
            } catch(e) {
                temporaryDirectory = OS.Constants.Path.tmpDir;
            }
            let download = yield Downloads.createDownload({
                source: aURI,
                target: OS.Path.join(temporaryDirectory, aURI.split("/").pop())
            });
            yield list.add(download);
            try {
                yield download.start();
                yield download.showContainingDirectory();
            } catch(e) {
                console.error(e);
                yield list.remove(download);
                yield download.finalize(true);
            }
        }).then(null, Components.utils.reportError);
    }

}

function startup(aData, aReason) {
    // Enable notification of missing fonts.
    if (aReason == ADDON_ENABLE || aReason == ADDON_INSTALL) {
        Cc["@mozilla.org/preferences-service;1"].
            getService(Ci.nsIPrefService).getBranch("gfx.missing_fonts.").
            setBoolPref("notify", true);
    }

    // Init the missing fonts notifier.
    gMissingFontsNotifier.init();
}

function shutdown(aData, aReason) {
    // Nothing to do when the application is shutting down.
    if (aReason == APP_SHUTDOWN) {
        return;
    }

    // Cleanup the missing fonts notifier.
    gMissingFontsNotifier.cleanup();

    // Reset preferences.
    let prefs = Cc["@mozilla.org/preferences-service;1"].
        getService(Ci.nsIPrefService);
    if (aReason == ADDON_DISABLE || aReason == ADDON_UNINSTALL) {
        prefs.getBranch("gfx.missing_fonts.").clearUserPref("notify");
    }
    if (aReason == ADDON_UNINSTALL) {
        prefs.resetBranch("missingfontsnotifier.");
    }
}

function install(aData, aReason) {
}

function uninstall(aData, aReason) {
}
