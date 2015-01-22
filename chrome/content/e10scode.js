const Cu = Components.utils;

Cu.import("resource://missingfontsnotifier/FontNeededObserver.jsm");

function uninstall() {
  removeMessageListener("MissingFontsNotifier:uninstall", uninstall);
  FontNeededObserver.uninstall();
}

addMessageListener("MissingFontsNotifier:uninstall", uninstall);
