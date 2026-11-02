package asia.junweirpa.piconsole.android;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;

/** Same-origin streaming downloads. Android only supplies the chosen output. */
public final class WorkspaceDownload {
    public static final class Failure extends IOException { Failure(String message) { super(message); } }
    interface Connector { HttpURLConnection open(String url) throws IOException; }
    private WorkspaceDownload() {}
    public static void copy(String url, String cookie, String agent, OutputStream output) throws IOException {
        copy(url,cookie,agent,output,value -> (HttpURLConnection)new URL(value).openConnection(),AppPolicy.MAX_DOWNLOAD_BYTES);
    }
    static void copy(String url, String cookie, String agent, OutputStream output, Connector connector, long maximum) throws IOException {
        String current=url;
        for(int redirects=0;redirects<=3;redirects++) {
            if(!AppPolicy.isWorkspaceUrl(current))throw new Failure("下载地址已改变，请重新获取文件。");
            HttpURLConnection connection=connector.open(current);
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(20000);connection.setReadTimeout(30000);
                connection.setRequestProperty("Accept-Encoding","identity");
                if(cookie!=null&&!cookie.isEmpty())connection.setRequestProperty("Cookie",cookie);
                if(agent!=null&&!agent.isEmpty())connection.setRequestProperty("User-Agent",agent);
                int status=connection.getResponseCode();
                if(status>=300&&status<400) {
                    String location=connection.getHeaderField("Location");
                    if(location==null||redirects==3)throw new Failure("下载链接重定向异常，请重新获取文件。");
                    try{current=new URI(current).resolve(location).toString();}catch(Exception error){throw new Failure("下载链接无效。");}
                    continue;
                }
                if(status==401||status==403)throw new Failure("登录已过期或没有文件权限，请重新登录后下载。");
                if(status!=200)throw new Failure("文件暂时无法下载，请稍后重试。");
                long length=connection.getContentLengthLong();
                if(length>maximum)throw new Failure("文件超过 100 MB，请使用电脑下载。");
                try(InputStream input=connection.getInputStream()) {
                    byte[] buffer=new byte[32768];long total=0;int count;
                    while((count=input.read(buffer))!=-1) {
                        if(Thread.currentThread().isInterrupted())throw new Failure("文件保存已中断，请重试。");
                        total+=count;if(total>maximum)throw new Failure("文件超过 100 MB，请使用电脑下载。");
                        output.write(buffer,0,count);
                    }
                    if(length>=0&&total!=length)throw new Failure("文件未下载完整，请重试。");
                }
                return;
            } finally { connection.disconnect(); }
        }
        throw new Failure("下载链接无效。");
    }
}
