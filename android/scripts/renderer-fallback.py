from pathlib import Path
p=Path('D:/code/pi-web/android/app/src/main/java/asia/junweirpa/piconsole/android/PiConsoleActivity.java')
s=p.read_text(encoding='utf-8')
old='''        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
'''
assert old in s
s=s.replace(old,'')
s=s.replace('''        installInsets();
        configureWebView();''','''        installInsets();
        try {
            web = new WebView(this);
            web.setBackgroundColor(Color.WHITE);
            root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
        } catch (RuntimeException unavailable) {
            showOffline("请在应用商店安装或启用 Android System WebView / Chrome，再重新打开 App。");
            return;
        }
        configureWebView();''')
s=s.replace('''        web.loadUrl(AppPolicy.isWorkspaceUrl(saved) ? saved : AppPolicy.HOME);''','''        openWorkspace(AppPolicy.isWorkspaceUrl(saved) ? saved : AppPolicy.HOME);''')
s=s.replace('''    private int dp(int value)''','''    private void openWorkspace(String url) {
        if (web == null) {
            showOffline("请先启用 Android System WebView / Chrome，再重新打开 App。"); return;
        }
        try {
            android.content.pm.PackageInfo renderer = WebView.getCurrentWebViewPackage();
            if (renderer != null && Integer.parseInt(renderer.versionName.split("\\\\.")[0]) < 120) {
                showOffline("请在应用商店更新 Android System WebView / Chrome，再重新打开 App。"); return;
            }
        } catch (NumberFormatException ignored) {}
        web.loadUrl(url);
    }

    private int dp(int value)''')
s=s.replace('retry.setOnClickListener(view -> web.loadUrl(AppPolicy.HOME))','retry.setOnClickListener(view -> openWorkspace(AppPolicy.HOME))')
s=s.replace('if (AppPolicy.isWorkspaceUrl(web.getUrl()))', 'if (web != null && AppPolicy.isWorkspaceUrl(web.getUrl()))')
s=s.replace('CookieManager.getInstance().flush(); web.onPause(); super.onPause();','if (web != null) { CookieManager.getInstance().flush(); web.onPause(); } super.onPause();')
p.write_text(s,encoding='utf-8')
