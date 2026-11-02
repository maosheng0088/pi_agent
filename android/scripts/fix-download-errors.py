from pathlib import Path
p=Path('D:/code/pi-web/android/app/src/main/java/asia/junweirpa/piconsole/android/PiConsoleActivity.java')
s=p.read_text(encoding='utf-8')
s=s.replace('    private void saveDownload(', '    private static final class DownloadFailure extends Exception { DownloadFailure(String message) { super(message); } }\n\n    private void saveDownload(')
s=s.replace('throw new Exception(', 'throw new DownloadFailure(')
s=s.replace('String message = error.getMessage();\n            final String detail = message != null && message.matches("[\\\\p{IsHan}\\\\s\\\\p{Punct}0-9A-Z]+") ? message :', 'final String detail = error instanceof DownloadFailure ? error.getMessage() :')
p.write_text(s,encoding='utf-8')
