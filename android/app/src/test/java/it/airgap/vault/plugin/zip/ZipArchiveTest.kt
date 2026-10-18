package it.airgap.vault.plugin.zip

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipException
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ZipArchiveTest {
    private fun archive(vararg names: String): ByteArrayInputStream {
        val bytes = ByteArrayOutputStream()
        ZipOutputStream(bytes).use { zip ->
            for (name in names) {
                zip.putNextEntry(ZipEntry(name))
                if (!name.endsWith('/')) zip.write("public fixture".toByteArray())
                zip.closeEntry()
            }
        }
        return ByteArrayInputStream(bytes.toByteArray())
    }

    private fun withRoot(test: (File, File) -> Unit) {
        val workspace = Files.createTempDirectory("vault-zip-test").toFile()
        try {
            val staging = File(workspace, "staging").apply { mkdirs() }
            test(workspace, staging)
        } finally { workspace.deleteRecursively() }
    }

    @Test fun extractsNestedModuleWithoutDirectoryEntries() = withRoot { _, root ->
        ZipArchive.extract(archive("module/manifest.json", "module/src/index.js"), root)
        assertEquals("public fixture", File(root, "module/manifest.json").readText())
        assertEquals("public fixture", File(root, "module/src/index.js").readText())
    }

    @Test fun rejectsTraversalAndPreservesExistingFileOutsideStaging() = withRoot { workspace, root ->
        val sentinel = File(workspace, "sentinel").apply { writeText("original") }
        val paths = listOf("../sentinel", "nested/../../sentinel", sentinel.absolutePath,
            "../staging-other/sentinel", "nested\\..\\sentinel", "./")
        for (name in paths) {
            var rejected = false
            try { ZipArchive.extract(archive(name), root) } catch (_: ZipException) { rejected = true }
            assertTrue("Must reject $name", rejected)
            assertEquals("original", sentinel.readText())
        }
        assertFalse(File(workspace, "staging-other").exists())
    }

    @Test fun rejectsExistingSymlinkToOutsideDirectory() = withRoot { workspace, root ->
        val outside = File(workspace, "outside").apply { mkdirs() }
        Files.createSymbolicLink(File(root, "link").toPath(), outside.toPath())
        var rejected = false
        try { ZipArchive.extract(archive("link/sentinel"), root) } catch (_: ZipException) { rejected = true }
        assertTrue(rejected)
        assertFalse(File(outside, "sentinel").exists())
        // Delete the link before the recursive fixture cleanup.
        Files.delete(File(root, "link").toPath())
    }

    @Test fun skipsMacMetadataAndRetainsModuleFiles() = withRoot { _, root ->
        ZipArchive.extract(archive("__MACOSX/ignored", "module/.DS_Store", "module/index.js"), root)
        assertFalse(File(root, "__MACOSX").exists())
        assertFalse(File(root, "module/.DS_Store").exists())
        assertTrue(File(root, "module/index.js").isFile)
    }
}
