this.EXPORTED_SYMBOLS = [ "FontNeededObserver" ];

const Ci = Components.interfaces;
const Cu = Components.utils;
const Cc = Components.classes;

Cu.import("resource://gre/modules/Services.jsm");

let observer = {
  observe(subject, topic, data) {
    Cc["@mozilla.org/childprocessmessagemanager;1"].
        getService(Ci.nsIMessageSender).
        sendAsyncMessage("MissingFontsNotifier:" + topic, data)
  }
};

Services.obs.addObserver(observer, "font-needed", false);

var FontNeededObserver = {
  uninstall() {
    Services.obs.removeObserver(observer, "font-needed");
  }
};
