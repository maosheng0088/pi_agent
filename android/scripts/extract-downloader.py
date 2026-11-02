from pathlib import Path
p=Path('D:/code/pi-web/android/app/src/main/java/asia/junweirpa/piconsole/android/PiConsoleActivity.java')
s=p.read_text(encoding='utf-8')
start=s.index('    private static final class DownloadFailure')
end=s.index('    private void handleBack()',start)
s=s[:start]+'''    private void saveDownload(PendingDownload download, Uri destination, String cookie) {
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

'''+s[end:]
for line in ['import java.io.InputStream;\n','import java.net.HttpURLConnection;\n','import java.net.URI;\n','import java.net.URL;\n']:
 s=s.replace(line,'')
s=s.replace('if (now - lastBack < 2000)', 'if (lastBack > 0 && now - lastBack < 2000)')
p.write_text(s,encoding='utf-8')
