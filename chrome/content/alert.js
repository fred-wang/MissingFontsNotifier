/* -*- Mode: Javascript; tab-width: 2; indent-tabs-mode:nil; -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

Components.utils.import("resource://gre/modules/Services.jsm");

const Ci = Components.interfaces;
const Cc = Components.classes;

var windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"]
                       .getService(Ci.nsIWindowMediator);

const WINDOW_MARGIN = 10;

var gAlertListener = null;
var gAlertTextClickable = false;
var gAlertCookie = "";

function prefillAlertInfo() {
  // unwrap all the args....
  // arguments[0] --> the image src url
  // arguments[1] --> the alert title
  // arguments[2] --> the alert text
  // arguments[3] --> is the text clickable?
  // arguments[4] --> the alert cookie to be passed back to the listener
  // arguments[5] --> an optional callback listener (nsIObserver)

  switch (window.arguments.length) {
    default:
    case 6:
      gAlertListener = window.arguments[5];
    case 5:
      gAlertCookie = window.arguments[4];
    case 4:
      gAlertTextClickable = window.arguments[3];
      if (gAlertTextClickable) {
        document.getElementById('alertNotification').setAttribute('clickable', true);
        document.getElementById('alertTextLabel').setAttribute('clickable', true);
      }
    case 3:
      document.getElementById('alertTextLabel').textContent = window.arguments[2];
    case 2:
      document.getElementById('alertTitleLabel').setAttribute('value', window.arguments[1]);
    case 1:
      if (window.arguments[0]) {
        document.getElementById('alertImage').setAttribute('src', window.arguments[0]);
      }
    case 0:
      break;
  }
}

function onAlertLoad() {
  let alertTextBox = document.getElementById("alertTextBox");
  let alertImageBox = document.getElementById("alertImageBox");
  alertImageBox.style.minHeight = alertTextBox.scrollHeight + "px";
  sizeToContent();
  moveWindowToEnd();
  window.addEventListener("XULAlertClose", function() { window.close(); });
}

function moveWindowToEnd() {
  let x = screen.availLeft + screen.availWidth - window.outerWidth;
  let y = screen.availTop;
  window.moveTo(x - WINDOW_MARGIN, y + WINDOW_MARGIN);
}

function onAlertBeforeUnload() {
  gAlertListener.observe(null, "alertfinished", gAlertCookie);
}

function onAlertClick() {
  gAlertListener.observe(null, "alertclickcallback", gAlertCookie);
  window.close();
}
