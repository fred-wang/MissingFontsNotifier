/* -*- Mode: Javascript; tab-width: 2; indent-tabs-mode:nil; -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

Components.utils.import("resource://gre/modules/Services.jsm");

var gDialogListener = null;

function onLoad()
{
    // Parse the arguments:
    // arguments[0] --> the inital list of missing scripts.
    // arguments[1] --> the dialog listener.
    switch (window.arguments.length) {
      default:
      case 2:
        gDialogListener = window.arguments[1];
      case 1:
        updateMissingScripts(window.arguments[0]);
      case 0:
        break;
    }
}

function updateMissingScripts(aMissingScripts)
{
    document.getElementById("missingScriptNames").value = aMissingScripts;
}

function onCancel()
{
    if (gDialogListener) {
        gDialogListener.observe(null, "dialogfinished", "cancel");
    }
    window.close();
}

function onAccept()
{
    if (gDialogListener) {
        gDialogListener.observe(null, "dialogfinished", "accept");
    }
    window.close();
}

function onAlwaysIgnore()
{
    if (gDialogListener) {
        gDialogListener.observe(null, "dialogfinished", "alwaysignore");
    }
    window.close();
}
