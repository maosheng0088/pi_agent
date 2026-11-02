package asia.junweirpa.piconsole.android;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.provider.DocumentsContract;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Thin Android client. All accounts, data and business execution stay on Pi Web. */
public final class PiConsoleActivity extends Activity {
    private static final int PICK_FILES = 201, SAVE_FILE = 202;
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private WebView web;
    private WebView popup;
    private FrameLayout root;
    private ProgressBar progress;
    private LinearLayout offline;
    private TextView offlineDetail;
    private ValueCallback<Uri[]> fileCallback;
    private PendingDownload pendingDownload;
    private boolean downloadInProgress;
    private boolean pageFailed;
    private long lastBack;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(244, 246, 251));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setProgressTintList(ColorStateList.valueOf(Color.rgb(52, 102, 235)));
        root.addView(progress, new FrameLayout.LayoutParams(-1, dp(3), Gravity.TOP));
        createOfflineView();
        setContentView(root);
        installInsets();
        try {
            web = new WebView(this);
            web.setBackgroundColor(Color.WHITE);
            root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
        } catch (RuntimeException unavailable) {
            showOffline("请在应用商店安装或启用 Android System WebView / Chrome，再重新打开 App。");
            return;
        }
        configureWebView();
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        String saved = state == null ? getPreferences(MODE_PRIVATE).getString("last_url", AppPolicy.HOME) : state.getString("last_url", AppPolicy.HOME);
        openWorkspace(AppPolicy.isWorkspaceUrl(saved) ? saved : AppPolicy.HOME);
    }

    private void openWorkspace(String url) {
        if (web == null) {
            showOffline("请先启用 Android System WebView / Chrome，再重新打开 App。"); return;
        }
        try {
            android.content.pm.PackageInfo renderer = WebView.getCurrentWebViewPackage();
            if (renderer != null && Integer.parseInt(renderer.versionName.split("\\.")[0]) < 120) {
                showOffline("请在应用商店更新 Android System WebView / Chrome，再重新打开 App。"); return;
            }
        } catch (NumberFormatException ignored) {}
        web.loadUrl(url);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void installInsets() {
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                root.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                WindowInsetsController controller = getWindow().getInsetsController();
                if (controller != null) controller.setSystemBarsAppearance(
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            } else {
                root.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        root.requestApplyInsets();
    }

    private void configureWebView() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setAllowFileAccess(false);
        // Content URIs are supplied only by the user-operated system picker.
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUserAgentString(settings.getUserAgentString() + " PiConsoleAndroid/0.1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        // No JavaScript-to-native bridge is exposed to remote content.
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                return route(request.getUrl().toString(), request.hasGesture());
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                pageFailed = false;
                offline.setVisibility(View.GONE);
                progress.setVisibility(View.VISIBLE);
            }
            @Override public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
                if (!pageFailed && AppPolicy.isWorkspaceUrl(url)) offline.setVisibility(View.GONE);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline("请检查网络连接，然后重新连接工作台。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) showOffline("工作台暂时无法连接，请稍后重试。");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (AppPolicy.isWorkspaceUrl(error.getUrl())) showOffline("无法验证工作台连接，请检查设备时间和网络后重试。");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                progress.setVisibility(value >= 100 || pageFailed ? View.GONE : View.VISIBLE);
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                if (!AppPolicy.isWorkspaceUrl(view.getUrl()) || params.getMode() == FileChooserParams.MODE_SAVE) {
                    finishPicker(null); return true;
                }
                String[] types = AppPolicy.acceptedMimeTypes(params.getAcceptTypes());
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(types.length == 1 ? types[0] : "*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
                try { startActivityForResult(Intent.createChooser(intent, "选择图片或文件"), PICK_FILES); }
                catch (Exception error) { finishPicker(null); toast("无法打开文件选择器，请确认已安装文件管理器。"); }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message result) {
                if (!userGesture) return false;
                if (popup != null) popup.destroy();
                final WebView temporary = new WebView(PiConsoleActivity.this);
                popup = temporary;
                temporary.getSettings().setJavaScriptEnabled(false);
                temporary.getSettings().setAllowFileAccess(false);
                temporary.getSettings().setAllowContentAccess(false);
                temporary.setWebViewClient(new WebViewClient() {
                    private boolean handled;
                    private void open(String url) {
                        if (handled || "about:blank".equals(url)) return;
                        handled = true;
                        if (AppPolicy.isWorkspaceUrl(url)) web.loadUrl(url); else route(url, true);
                        temporary.post(() -> { temporary.destroy(); if (popup == temporary) popup = null; });
                    }
                    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { open(request.getUrl().toString()); return true; }
                    @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) { open(url); }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(temporary);
                result.sendToTarget();
                return true;
            }
        });
        web.setDownloadListener(this::chooseDownloadLocation);
    }

    private boolean route(String url, boolean gesture) {
        if (AppPolicy.isWorkspaceUrl(url)) return false;
        if (!gesture) return true;
        try {
            Uri uri = Uri.parse(url);
            if (AppPolicy.isExternalWebUrl(url)) startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
            else if ("mailto".equalsIgnoreCase(uri.getScheme())) startActivity(new Intent(Intent.ACTION_SENDTO, uri));
            else if ("tel".equalsIgnoreCase(uri.getScheme())) startActivity(new Intent(Intent.ACTION_DIAL, uri));
            else toast("此链接无法在工作台内打开。");
        } catch (Exception error) { toast("没有可用于打开此链接的应用。"); }
        return true;
    }

    private void createOfflineView() {
        offline = new LinearLayout(this);
        offline.setOrientation(LinearLayout.VERTICAL);
        offline.setGravity(Gravity.CENTER);
        offline.setPadding(dp(28), dp(28), dp(28), dp(28));
        offline.setBackgroundColor(Color.rgb(244, 246, 251));
        TextView mark = new TextView(this);
        mark.setText("π"); mark.setTextColor(Color.WHITE); mark.setTextSize(40); mark.setGravity(Gravity.CENTER);
        GradientDrawable background = new GradientDrawable(); background.setColor(Color.rgb(52, 102, 235)); background.setCornerRadius(dp(18)); mark.setBackground(background);
        offline.addView(mark, new LinearLayout.LayoutParams(dp(72), dp(72)));
        TextView title = new TextView(this); title.setText("暂时无法连接"); title.setTextSize(22); title.setTypeface(null, Typeface.BOLD); title.setTextColor(Color.rgb(27, 45, 73));
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(-2, -2); titleParams.topMargin = dp(24); offline.addView(title, titleParams);
        offlineDetail = new TextView(this); offlineDetail.setTextSize(14); offlineDetail.setTextColor(Color.rgb(100, 116, 139)); offlineDetail.setGravity(Gravity.CENTER); offlineDetail.setLineSpacing(dp(4), 1);
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2); detailParams.topMargin = dp(12); detailParams.bottomMargin = dp(24); offline.addView(offlineDetail, detailParams);
        Button retry = new Button(this); retry.setText("重新连接"); retry.setTextColor(Color.WHITE); retry.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(52, 102, 235)));
        offline.addView(retry, new LinearLayout.LayoutParams(-1, dp(52)));
        retry.setOnClickListener(view -> openWorkspace(AppPolicy.HOME));
        Button browser = new Button(this); browser.setText("在浏览器中打开"); browser.setTextColor(Color.rgb(52, 102, 235)); browser.setBackgroundTintList(ColorStateList.valueOf(Color.TRANSPARENT));
        offline.addView(browser, new LinearLayout.LayoutParams(-1, dp(52)));
        browser.setOnClickListener(view -> { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(AppPolicy.HOME))); } catch (Exception error) { toast("没有可用的浏览器。"); } });
        offline.setVisibility(View.GONE);
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));
    }

    private void showOffline(String detail) { pageFailed = true; progress.setVisibility(View.GONE); offlineDetail.setText(detail); offline.setVisibility(View.VISIBLE); }
    private void toast(String message) { if (!isDestroyed()) Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private void finishPicker(Uri[] result) { ValueCallback<Uri[]> callback = fileCallback; fileCallback = null; if (callback != null) callback.onReceiveValue(result); }

    private static final class PendingDownload {
        final String url, userAgent, mime, filename;
        PendingDownload(String url, String userAgent, String mime, String filename) { this.url=url; this.userAgent=userAgent; this.mime=mime; this.filename=filename; }
    }

    private void chooseDownloadLocation(String url, String userAgent, String disposition, String mime, long length) {
        if (!AppPolicy.isWorkspaceUrl(url)) { toast("请使用工作台返回的文件下载链接。"); return; }
        if (pendingDownload != null || downloadInProgress) { toast("请先完成当前文件保存。"); return; }
        if (length > AppPolicy.MAX_DOWNLOAD_BYTES) { toast("文件超过 100 MB，请使用电脑下载。"); return; }
        String filename = AppPolicy.safeFileName(URLUtil.guessFileName(url, disposition, mime));
        pendingDownload = new PendingDownload(url, userAgent, AppPolicy.safeMime(mime), filename);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(pendingDownload.mime).putExtra(Intent.EXTRA_TITLE, filename);
        try { startActivityForResult(intent, SAVE_FILE); }
        catch (Exception error) { pendingDownload = null; toast("无法打开文件保存位置，请确认已安装文件管理器。"); }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILES) {
            if (result != RESULT_OK || data == null) { finishPicker(null); return; }
            ArrayList<Uri> uris = new ArrayList<>();
            ClipData clips = data.getClipData();
            if (clips != null) for (int i=0; i<clips.getItemCount(); i++) uris.add(clips.getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
            if (uris.isEmpty() || uris.size() > 10) { finishPicker(null); toast("一次最多选择 10 个文件。"); return; }
            for (Uri uri : uris) {
                if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null || uri.getAuthority().startsWith(getPackageName())) { finishPicker(null); toast("请选择文件管理器中的图片或文件。"); return; }
            }
            finishPicker(uris.toArray(new Uri[0]));
        } else if (request == SAVE_FILE) {
            PendingDownload download = pendingDownload; pendingDownload = null;
            if (result != RESULT_OK || data == null || data.getData() == null || download == null) return;
            Uri destination = data.getData();
            if (!"content".equals(destination.getScheme())) { toast("请选择文件管理器中的保存位置。"); return; }
            String cookie = CookieManager.getInstance().getCookie(download.url);
            downloadInProgress = true; toast("正在保存文件…");
            downloads.execute(() -> saveDownload(download, destination, cookie));
        }
    }

    private void saveDownload(PendingDownload download, Uri destination, String cookie) {
        try (OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
            if (output == null) throw new WorkspaceDownload.Failure("无法写入所选位置，请换一个位置重试。");
            WorkspaceDownload.copy(download.url, cookie, download.userAgent, output);
            runOnUiThread(() -> toast("文件已保存到所选位置。"));
        } catch (Exception error) {
            try { DocumentsContract.deleteDocument(getContentResolver(), destination); } catch (Exception ignored) {}
            final String detail = error instanceof WorkspaceDownload.Failure ? error.getMessage() : "文件保存失败，请检查网络和保存位置后重试。";
            runOnUiThread(() -> toast(detail));
        } finally { runOnUiThread(() -> downloadInProgress = false); }
    }

    private void handleBack() {
        if (offline.getVisibility() == View.VISIBLE) { finish(); return; }
        if (web.canGoBack()) { web.goBack(); return; }
        long now = android.os.SystemClock.elapsedRealtime();
        if (lastBack > 0 && now - lastBack < 2000) finish(); else { lastBack = now; toast("再按一次返回退出 PiConsole。"); }
    }
    @Override public void onBackPressed() { handleBack(); }
    @Override protected void onSaveInstanceState(Bundle state) { if (web != null && AppPolicy.isWorkspaceUrl(web.getUrl())) state.putString("last_url", web.getUrl()); super.onSaveInstanceState(state); }
    @Override protected void onPause() {
        if (web != null && AppPolicy.isWorkspaceUrl(web.getUrl())) getPreferences(MODE_PRIVATE).edit().putString("last_url", web.getUrl()).apply();
        if (web != null) { CookieManager.getInstance().flush(); web.onPause(); } super.onPause();
    }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() {
        finishPicker(null); downloads.shutdownNow(); if (popup != null) popup.destroy();
        if (web != null) { root.removeView(web); web.stopLoading(); web.destroy(); }
        super.onDestroy();
    }
}
