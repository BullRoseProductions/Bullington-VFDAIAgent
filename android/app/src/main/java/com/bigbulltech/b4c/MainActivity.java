package com.bigbulltech.b4c;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // IGNORE THE DEVICE'S SYSTEM FONT-SIZE SETTING. The WebView honours the OS font scale, and
    // this app's layouts are fixed-pixel with no room for inflated text — at larger display sizes
    // labels collide and whole screens become unreadable. Locking text zoom to 100% is a STOPGAP;
    // the durable fix is making the UI font-scale-flexible, which is a real piece of work across
    // every screen and is not this change.
    //
    // NULL-GUARDED, and not out of superstition. BridgeActivity.onCreate RETURNS EARLY when
    // setContentView throws — a device with a missing, disabled or updating Android System WebView
    // — and on that path it shows the no_webview layout and never calls load(), so the bridge is
    // never built. Reaching through it unguarded would turn "this phone has no WebView" into a
    // launch crash, which is a worse failure than the one being fixed and would land on exactly
    // the devices least able to report it. On every normal launch the bridge exists by here:
    // super.onCreate calls load(), which constructs it.
    if (this.getBridge() != null) {
      WebView webView = this.getBridge().getWebView();
      if (webView != null) {
        webView.getSettings().setTextZoom(100);
      }
    }
  }
}
