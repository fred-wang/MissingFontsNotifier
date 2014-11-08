/* -*- Mode: Javascript; tab-width: 2; indent-tabs-mode:nil; -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
const kNotified = 0;
const kIgnored = 1;

Cu.import("resource://gre/modules/Services.jsm");

let gMissingFontsNotifier = {

    mAlertWindow: null,
    mDialogWindow: null,
    mScripts: null,

    closeAllWindowsOfType: function(aType) {
        var windows = Cc["@mozilla.org/appshell/window-mediator;1"]
            .getService(Ci.nsIWindowMediator).getEnumerator(aType);
        while (windows.hasMoreElements()) {
            windows.getNext().close();
        }
    },

    init: function() {
        this.closeAllWindowsOfType("alert:missingfontsnotifier");
        this.closeAllWindowsOfType("dialog:missingfontsnotifier");
        this.mAlertWindow = null;
        this.mDialogWindow = null;
        this.mScripts = {};
        this.loadPreferences();
        Services.obs.addObserver(this, "font-needed", false);
        Cc["@mozilla.org/preferences-service;1"].
            getService(Ci.nsIPrefService).getBranch("missingfontsnotifier.").
            addObserver("", this, false);
    },

    cleanup: function() {
        this.closeAllWindowsOfType("alert:missingfontsnotifier");
        this.closeAllWindowsOfType("dialog:missingfontsnotifier");
        Services.obs.removeObserver(this, "font-needed");
        Cc["@mozilla.org/preferences-service;1"].
            getService(Ci.nsIPrefService).getBranch("missingfontsnotifier.").
            removeObserver("ignored_scripts", this);
        this.savePreferences();
    },

    observe: function(aSubject, aTopic, aData) {
        switch (aTopic) {
          case "nsPref:changed":
            // FIXME: This does not seem to work for changes from about:config
            this.prefChanged(aSubject, aData);
            break;
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

    serializeMissingScripts: function() {
        let missingScripts = "";
        for (let name in this.mScripts) {
            if (this.mScripts[name] == kNotified) {
                if (missingScripts.length) {
                    // FIXME: use a localizable format for commas?
                    missingScripts += ", ";
                }
                missingScripts += this.getString(name);
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

    prefChanged: function(aSubject, aData) {
        if (aData != "ignored_scripts") {
            return;
        }
        for (let name in this.mScripts) {
            if (this.mScripts[name] == kIgnored) {
                delete this.mScripts[name];
            }
        }
        this.loadPreferences();
        if (this.mDialogWindow) {
            this.mDialogWindow.
                updateMissingScripts(this.serializeMissingScripts());
        }
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
                updateMissingScripts(this.serializeMissingScripts());
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
                ["chrome://missingfontsnotifier/skin/notification-48.png",
                 this.getString("notificationTitle"),
                 this.getString("notificationMessage"),
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
                [this.serializeMissingScripts(), this];
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
            // TODO: implement download and (optionally) installation of fonts.
            break;
          default: // "cancel"
            break;
        }
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
