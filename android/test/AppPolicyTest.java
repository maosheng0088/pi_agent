import asia.junweirpa.piconsole.android.AppPolicy;
import java.util.Arrays;

public class AppPolicyTest {
    private static int checks;
    private static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
    public static void main(String[] args) {
        for(String url:new String[]{AppPolicy.HOME,"https://AI.JUNWEIRPA.ASIA:443/#agent=group-a","https://ai.junweirpa.asia/api/sessions/a/attachments/report?download=1"})check(AppPolicy.isWorkspaceUrl(url),"Trusted company URL rejected");
        for(String url:new String[]{"http://ai.junweirpa.asia/","https://ai.junweirpa.asia.evil.test/","https://ai.junweirpa.asia@evil.test/","https://user@ai.junweirpa.asia/","https://ai.junweirpa.asia:444/","file:///data/data/private","content://private/file","javascript:alert(1)","intent://evil","https://ai.junweirpa.asia\\@evil.test/","//ai.junweirpa.asia/",null})check(!AppPolicy.isWorkspaceUrl(url),"Untrusted URL accepted: "+url);
        check(AppPolicy.isExternalWebUrl("https://developer.android.com/"),"External HTTPS link");
        check(!AppPolicy.isExternalWebUrl("https://password@evil.test"),"Embedded credentials");
        check(!AppPolicy.isExternalWebUrl("intent://other-app"),"Intent scheme");
        check(!AppPolicy.isExternalWebUrl("https://example.com:99999"),"Invalid port");
        check(AppPolicy.safeFileName("../../报告\u202e.pdf").equals("_.._报告_.pdf"),"Unsafe filename characters");
        check(AppPolicy.safeFileName("").equals("PiConsole文件"),"Empty filename");
        String longName=String.join("", java.util.Collections.nCopies(200,"文"))+".xlsx";
        check(AppPolicy.safeFileName(longName).endsWith(".xlsx")&&AppPolicy.safeFileName(longName).length()<=160,"Filename length and extension");
        check(AppPolicy.safeMime("APPLICATION/PDF; charset=utf-8").equals("application/pdf"),"MIME normalization");
        check(AppPolicy.safeMime("text/html\r\nHeader: value").equals("application/octet-stream"),"Malformed MIME");
        check(Arrays.equals(AppPolicy.acceptedMimeTypes(new String[]{"image/png,image/jpeg","image/png"}),new String[]{"image/png","image/jpeg"}),"Picker MIME deduplication");
        check(Arrays.equals(AppPolicy.acceptedMimeTypes(new String[]{".exe","bad-value"}),new String[]{"*/*"}),"Unknown picker filter");
        check(Arrays.equals(AppPolicy.acceptedMimeTypes(new String[]{"image/png","*/*"}),new String[]{"*/*"}),"Wildcard picker filter");
        System.out.println("AppPolicy checks passed: "+checks);
    }
}
