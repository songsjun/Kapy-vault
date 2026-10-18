package android.system;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;

/** JVM equivalent of Android's same-filesystem POSIX rename, with fault injection. */
public final class Os {
    public static boolean failNextRename;
    public static void rename(String source, String target) throws IOException {
        if (failNextRename) {
            failNextRename = false;
            throw new IOException("Public test: rename failed");
        }
        Files.move(Paths.get(source), Paths.get(target),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
}
