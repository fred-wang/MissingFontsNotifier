/* -*- Mode: Javascript; tab-width: 2; indent-tabs-mode:nil; -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

////////////////////////////////////////////////////////////////////////////////
// "gfx.missing_fonts.notify"
// This is a boolean preference enabled by the addon. It will make Gecko raise
// "missing font" notifications when it fails to draw a given character.
// The notification message contains the Unicode script to which the missing
// character belongs, with "Zmth" used for MathML and math characters
// (see en.wikipedia.org/wiki/Script_%28Unicode%29#Table_of_scripts_in_Unicode).
// Note that for each Unicode script, such a notification will only happen once
// per browser session
// (see https://bugzilla.mozilla.org/show_bug.cgi?id=619521#c120).
//
// "missingfontsnotifier.ignored_scripts"
// This a string preference storing the comma-separated list of Unicode scripts
// that the user decided to ignore. The addon won't notify again for these
// missing scripts, unless the preference is reset.
//
// "missingfontsnotifier.packagekitnames"
// This is the comma-separated list of PackageKitName* keys that the addon will
// consider (see below) and is initialized to kDefaultPackageKitNames.
// Set the value to an empty list if you don't want the addon to use PackageKit.
const kDefaultPackageKitNames = ["debian", "fedora"];
//
// "missingfontsnotifier.fontserver"
// This is the URI of the server from which the fonts are downloaded
// (see below) and is initialized to kDefaultFontServer.
// Set the value to "null" if you don't want the addon to download font files
// from such a server.
const kDefaultFontServer = "https://fred-wang.github.io/mozilla-font-server/";
//
// chrome/content/fonts.json
// This file contains the JSON font data described by key:value pairs. Each
// key is a unicode script and the associate value is a Javascript object of
// the form
// {
//    "PackageKitName1": "FontPackageName1",
//    "PackageKitName2": "FontPackageName2",
//    ...
//    "download": "FontFile"
// }
// where
// 1) All the key:value pairs are optional.
// 2) The PackageKitName* key identifies a package kit set for a given
//   distribution (e.g. "fedora") and the value FontPackageName* is the
//   corresponding font package name to install for the given Unicode script.
// 3) FontFile is the file name of a font to download from the font server
//   (see kDefaultFontServer) for the given Unicode script.
//
// If you wish to add more fonts or data, please send a pull request to
// https://github.com/fred-wang/MissingFontsNotifier/pulls
// If instead you want to restrict the font data to consider for your custom
// distribution of that addon, you might just want to keep a patch to change
// the kDefaultPackageKitNames and kDefaultFontServer values above.
//
////////////////////////////////////////////////////////////////////////////////
const kE10sCode = "chrome://missingfontsnotifier/content/e10scode.js";
const kIcon = "chrome://missingfontsnotifier/skin/notification-48.png";
const kNotified = 0;
const kProcessed = 1;
const kIgnored = 2;

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Downloads.jsm");
Cu.import("resource://gre/modules/osfile.jsm")
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/devtools/Console.jsm");

let gMissingFontsNotifier = {

    init: function() {
        // This will contain the JSON font data.
        this.mFontData = null;

        // This is an object containing pair "script-name: state" for the script
        // names we already handled. The state can be kNotified (displayed in
        // the alert/dialog windows), kProcessed (the user clicked "OK" in the
        // dialog) or kIgnored (the user clicked "Ignore" in the dialog,
        // perhaps in a previous session).
        this.mScripts = {};

        // These are reference to our custom alert and dialog windows, to ensure
        // that we only open one at a time.
        this.mAlertWindow = null;
        this.mDialogWindow = null;

        // Close all windows.
        this.closeAllWindowsOfType("alert:missingfontsnotifier");
        this.closeAllWindowsOfType("dialog:missingfontsnotifier");

        // Initialize the variables to manage PackageKit transactions.
        this.mPackageKitService = null;
        this.mPackagesToDownload = [];

        // Initialize the preferences.
        this.mPackageKitNames = kDefaultPackageKitNames;
        this.mFontServer = kDefaultFontServer;
        this.loadPreferences();
        try {
            let service = Cc["@mozilla.org/packagekit-service;1"].
                getService(Ci.nsIPackageKitService);
        } catch(e) {
            // If nsIPackageKitService is not available, never use PackageKit.
            this.mPackageKitNames = [];
        }

        // Observer notifications from the child process.
        Cc["@mozilla.org/parentprocessmessagemanager;1"].
            getService(Ci.nsIMessageListenerManager).
            addMessageListener("MissingFontsNotifier:font-needed", this);
    },

    cleanup: function() {
        this.closeAllWindowsOfType("alert:missingfontsnotifier");
        this.closeAllWindowsOfType("dialog:missingfontsnotifier");
        this.savePreferences();

        // Unobserve notifications from the child process.
        Cc["@mozilla.org/parentprocessmessagemanager;1"].
            getService(Ci.nsIMessageListenerManager).
            removeMessageListener("MissingFontsNotifier:font-needed", this);
    },

    closeAllWindowsOfType: function(aType) {
        let windows = Cc["@mozilla.org/appshell/window-mediator;1"]
            .getService(Ci.nsIWindowMediator).getEnumerator(aType);
        while (windows.hasMoreElements()) {
            windows.getNext().close();
        }
    },

    receiveMessage: function(aMessage) {
        if (aMessage.name == "MissingFontsNotifier:font-needed") {
            this.observe(null, "font-needed", aMessage.data);
        }
    },

    showAlertNotification: function(aMessage) {
        console.warn(this.getString("notificationTitle") + " - " + aMessage);
        Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService).
            showAlertNotification(kIcon,
                                  this.getString("notificationTitle"),
                                  aMessage,
                                  false, "", null, "");
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
            if (aData) {
                // An error occurred during the PackageKit transaction.
                this.showAlertNotification(aData);
            }
            this.mPackageKitService = null;
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
            this.mPackageKitNames =
                preferences.getCharPref("packagekitnames").split(",");
        }
        if (preferences.prefHasUserValue("fontserver")) {
            this.mFontServer = preferences.getCharPref("fontserver");
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
            } else if (!(this.mScripts.hasOwnProperty(aElement))) {
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

    processScripts: function(aScriptsToProcess) {
        let name, data;
        let noFontsAvailable = [];

        // Try and find a way to get appropriate font for each script.
        while (aScriptsToProcess.length) {
            name = aScriptsToProcess.pop();
            if (name in this.mFontData) {
                data = this.mFontData[name];

                // Try each of the package kit name in this.mPackageKitNames
                if (this.mPackageKitNames.length) {
                    let foundFontPackage = false;
                    for (let packageKitName of this.mPackageKitNames) {
                        if (data[packageKitName]) {
                            this.mPackagesToDownload.push(data[packageKitName]);
                            foundFontPackage = true;
                        }
                    }
                    if (foundFontPackage) {
                        continue;
                    }
                }

                // Try and find a file from the font server.
                if (this.mFontServer && data.download) {
                    this.downloadFrom(this.mFontServer + "/" + data.download);
                    continue;
                }
            }

            // No appropriate fonts found for that script.
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
            this.mPackagesToDownload.forEach(function(aPackage) {
                let p = Cc["@mozilla.org/supports-string;1"].
                    createInstance(Ci.nsISupportsString);
                p.data = aPackage;
                packages.appendElement(p, false);
            });
            this.mPackagesToDownload = [];
            this.mPackageKitService.installPackages(this.mPackageKitService.
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

    // Load the module observing "font-needed" notifications.
    let resource = Services.io
        .getProtocolHandler("resource")
        .QueryInterface(Ci.nsIResProtocolHandler);
    let alias = Services.io.newFileURI(aData.installPath);
    if (!aData.installPath.isDirectory()) {
        alias = Services.io.newURI("jar:" + alias.spec + "!/resources/",
                                   null, null);
    }
    resource.setSubstitution("missingfontsnotifier", alias);
    Cc["@mozilla.org/globalmessagemanager;1"].
        getService(Ci.nsIMessageListenerManager).
        loadFrameScript(kE10sCode, true);

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

    // Remove the module observing "font-needed" notifications.
    let resource = Services.io
        .getProtocolHandler("resource")
        .QueryInterface(Ci.nsIResProtocolHandler);
    resource.setSubstitution("missingfontsnotifier", null);
    Cc["@mozilla.org/globalmessagemanager;1"].
        getService(Ci.nsIMessageListenerManager).
        removeDelayedFrameScript(kE10sCode);

    // Disable notification of missing fonts.
    if (aReason == ADDON_DISABLE || aReason == ADDON_UNINSTALL) {
        Cc["@mozilla.org/preferences-service;1"].
            getService(Ci.nsIPrefService).
            getBranch("gfx.missing_fonts.").clearUserPref("notify");
    }
}

function install(aData, aReason) {
    // Initialize the addon preferences.
    let preferences = Cc["@mozilla.org/preferences-service;1"].
        getService(Ci.nsIPrefService).getBranch("missingfontsnotifier.");
    preferences.setCharPref("packagekitnames",
                            kDefaultPackageKitNames.toString());
    preferences.setCharPref("fontserver",
                            kDefaultFontServer);
}

function uninstall(aData, aReason) {
    // Unregister the module observing "font-needed" notifications.
    Cc["@mozilla.org/globalmessagemanager;1"].
        getService(Ci.nsIMessageBroadcaster).
        broadcastAsyncMessage("MissingFontsNotifier:uninstall", {});

    // Reset the addon preferences.
    Cc["@mozilla.org/preferences-service;1"].
        getService(Ci.nsIPrefService).resetBranch("missingfontsnotifier.");
}
