package asia.junweirpa.piconsole.android;

import java.io.*;
import java.net.*;
import java.util.*;

public class WorkspaceDownloadTest {
    private static int checks;
    private static final class Fake extends HttpURLConnection {
        final byte[] body;final int code;final String redirect;final long length;boolean read,closed;
        Fake(String url,int code,String redirect,String body,long length)throws Exception{super(new URL(url));this.code=code;this.redirect=redirect;this.body=body.getBytes("UTF-8");this.length=length;}
        public void connect(){}public boolean usingProxy(){return false;}public void disconnect(){closed=true;}
        public int getResponseCode(){return code;}public long getContentLengthLong(){return length;}
        public String getHeaderField(String name){return "Location".equals(name)?redirect:null;}
        public InputStream getInputStream(){read=true;return new ByteArrayInputStream(body);}
    }
    private static void check(boolean value,String message){checks++;if(!value)throw new AssertionError(message);}
    private static void fail(Fake value,long maximum)throws Exception{
        try{WorkspaceDownload.copy(value.getURL().toString(),"session=private","PiConsoleTest",new ByteArrayOutputStream(),url->value,maximum);throw new AssertionError("Download should fail");}
        catch(IOException expected){check(value.closed,"Connection must close on failure");}
    }
    public static void main(String[] args)throws Exception {
        String url=AppPolicy.HOME+"api/sessions/a/attachments/a?download=1";
        Fake okay=new Fake(url,200,null,"report",6);ByteArrayOutputStream output=new ByteArrayOutputStream();
        WorkspaceDownload.copy(url,"session=private","PiConsoleTest",output,value->okay,100);
        check(output.toString("UTF-8").equals("report"),"Result bytes");check("session=private".equals(okay.getRequestProperty("Cookie")),"Authenticated download");check(okay.closed,"Success closes connection");check(!okay.getInstanceFollowRedirects(),"No automatic credential redirects");
        Fake cross=new Fake(url,302,"https://other.test/collect","",0);final int[] calls={0};
        try{WorkspaceDownload.copy(url,"session=private","test",new ByteArrayOutputStream(),value->{calls[0]++;return cross;},100);throw new AssertionError("Cross-origin redirect accepted");}catch(WorkspaceDownload.Failure expected){check(calls[0]==1,"No external request with cookies");check(cross.closed,"Redirect connection closed");}
        Fake first=new Fake(url,302,"/api/report","",0),second=new Fake(AppPolicy.HOME+"api/report",200,null,"done",4);List<String> targets=new ArrayList<>();output=new ByteArrayOutputStream();
        WorkspaceDownload.copy(url,"session=private","test",output,value->{targets.add(value);return targets.size()==1?first:second;},100);
        check(targets.size()==2&&targets.get(1).equals(AppPolicy.HOME+"api/report"),"Relative same-origin redirect");check(output.toString("UTF-8").equals("done"),"Redirect body");
        Fake auth=new Fake(url,401,null,"login",5);fail(auth,100);check(!auth.read,"Do not save authorization error body");
        Fake forbidden=new Fake(url,403,null,"denied",6);fail(forbidden,100);
        Fake huge=new Fake(url,200,null,"data",101);fail(huge,100);check(!huge.read,"Reject declared oversized file before reading");
        fail(new Fake(url,200,null,"123456789",-1),8);
        fail(new Fake(url,200,null,"short",99),100);
        fail(new Fake(url,206,null,"partial",7),100);
        final int[] loop={0};try{WorkspaceDownload.copy(url,null,null,new ByteArrayOutputStream(),value->{loop[0]++;try{return new Fake(value,302,"/loop","",0);}catch(Exception e){throw new IOException(e);}},100);throw new AssertionError("Redirect loop accepted");}catch(WorkspaceDownload.Failure expected){check(loop[0]==4,"Bounded redirect loop");}
        Fake disk=new Fake(url,200,null,"report",6);try{WorkspaceDownload.copy(url,null,null,new OutputStream(){public void write(int b)throws IOException{throw new IOException("Disk full");}},value->disk,100);throw new AssertionError("Failed output accepted");}catch(IOException expected){check(disk.closed,"Disconnect after failed output");}
        System.out.println("WorkspaceDownload checks passed: "+checks);
    }
}
