import java.util.List;
import com.cwnupaa.proctor.api.MediaTlsKt;

/** Run against :app:assembleDebug's compiled Kotlin; no device or real exam. */
public final class MediaTlsTest {
  static int checks;
  static void matches(boolean expected, String host, int type, String name) {
    boolean actual = MediaTlsKt.mediaHostnameMatches(host, List.of(List.of(type, name)));
    if (actual != expected) throw new AssertionError(host + " / " + name + " expected " + expected);
    checks++;
  }
  public static void main(String[] args) {
    matches(true, "media.example.com", 2, "media.example.com");
    matches(true, "MEDIA.EXAMPLE.COM", 2, "media.example.com");
    matches(false, "media.example.com.evil.test", 2, "media.example.com");
    matches(false, "media.example.com", 2, "other.example.com");
    matches(true, "media.example.com", 2, "*.example.com");
    matches(false, "a.media.example.com", 2, "*.example.com");
    matches(false, "example.com", 2, "*.example.com");
    matches(false, "exam.com", 2, "*.com");
    matches(false, "127.0.0.1", 2, "127.0.0.1");
    matches(true, "127.0.0.1", 7, "127.0.0.1");
    matches(false, "127.0.0.2", 7, "127.0.0.1");
    matches(true, "[::1]", 7, "0:0:0:0:0:0:0:1");
    if (MediaTlsKt.mediaHostnameMatches("media.example.com", null)) throw new AssertionError("SAN is required");
    checks++;
    System.out.println(checks + " media TLS hostname checks passed");
  }
}
