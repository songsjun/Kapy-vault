package it.airgap.vault.plugin.zip

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.zip.ZipException
import java.util.zip.ZipInputStream

/** Extracts only inside the app-owned staging directory, before module verification. */
internal object ZipArchive {
    private val ignoredNames = setOf("__MACOSX", ".DS_Store")

    @Throws(IOException::class)
    fun extract(input: InputStream, destination: File) {
        val root = destination.canonicalFile
        ZipInputStream(input).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                val parts = entry.name.split('/', '\\')
                if (entry.name.isEmpty() || File(entry.name).isAbsolute ||
                    parts.any { it == ".." } || entry.name.contains('\\')) {
                    throw ZipException("Archive entry is outside the extraction directory")
                }
                // canonicalFile also resolves existing symlinks. A string prefix without
                // the separator would incorrectly allow a sibling such as staging-other.
                val target = File(root, entry.name).canonicalFile
                if (!target.path.startsWith(root.path + File.separator)) {
                    throw ZipException("Archive entry is outside the extraction directory")
                }
                if (parts.any { it in ignoredNames }) {
                    zip.closeEntry()
                    continue
                }
                if (entry.isDirectory) {
                    if (!target.isDirectory && !target.mkdirs()) {
                        throw IOException("Failed to create extraction directory")
                    }
                } else {
                    val parent = target.parentFile
                    if (!parent.isDirectory && !parent.mkdirs()) {
                        throw IOException("Failed to create extraction directory")
                    }
                    target.outputStream().use { zip.copyTo(it) }
                }
                zip.closeEntry()
            }
        }
    }
}
