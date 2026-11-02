package asia.junweirpa.piconsole.android;

import java.net.URI;
import java.util.LinkedHashSet;
import java.util.Locale;

/** Platform-independent policy, exercised by the host-side Java tests. */
public final class AppPolicy {
    public static final String HOME = "https://ai.junweirpa.asia/";
    public static final long MAX_DOWNLOAD_BYTES = 100L * 1024 * 1024;
    private AppPolicy() {}

    public static boolean isWorkspaceUrl(String value) {
        try {
            URI uri = new URI(value);
            return "https".equalsIgnoreCase(uri.getScheme()) && "ai.junweirpa.asia".equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getRawUserInfo() == null;
        } catch (Exception ignored) { return false; }
    }

    public static boolean isExternalWebUrl(String value) {
        try {
            URI uri = new URI(value);
            return ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))
                && uri.getHost() != null && uri.getRawUserInfo() == null && uri.getPort() != 0 && uri.getPort() <= 65535;
        } catch (Exception ignored) { return false; }
    }

    public static String safeFileName(String value) {
        String clean = value == null ? "" : value.replaceAll("[\\p{Cntrl}\\p{Cf}/\\\\]", "_").trim().replaceAll("^\\.+", "");
        if (clean.isEmpty()) clean = "PiConsole文件";
        if (clean.codePointCount(0, clean.length()) > 160) {
            String suffix = "";
            int dot = clean.lastIndexOf('.');
            if (dot > 0 && clean.length() - dot <= 16) suffix = clean.substring(dot);
            clean = clean.substring(0, clean.offsetByCodePoints(0, 160 - suffix.length())) + suffix;
        }
        return clean;
    }

    public static String safeMime(String value) {
        String mime = value == null ? "" : value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return mime.matches("[a-z0-9!#$&^_.+-]+/(?:[a-z0-9!#$&^_.+-]+|\\*)") ? mime : "application/octet-stream";
    }

    public static String[] acceptedMimeTypes(String[] values) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        if (values != null) for (String raw : values) {
            if (raw == null) continue;
            for (String item : raw.split(",")) {
                String mime = item.trim().toLowerCase(Locale.ROOT);
                if ("*/*".equals(mime)) return new String[]{"*/*"};
                if (mime.matches("[a-z0-9!#$&^_.+-]+/(?:[a-z0-9!#$&^_.+-]+|\\*)") && result.size() < 20) result.add(mime);
            }
        }
        return result.isEmpty() ? new String[]{"*/*"} : result.toArray(new String[0]);
    }
}
