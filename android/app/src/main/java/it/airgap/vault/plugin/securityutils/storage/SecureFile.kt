package it.airgap.vault.plugin.securityutils.storage

import android.system.Os
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException

class SecureFile(parent: File, name: String, private val immediatelySave: Boolean = true) {

    constructor(parent: File, hashedKey: ByteArray, immediatelySave: Boolean = true) : this(parent, hashedKey.toHexString(), immediatelySave)

    private val source: File = File(parent, name)
    private val temp: File by lazy {
        File(parent, "$name\$temp").also {
            if (source.exists()) {
                source.inputStream().use { input ->
                    atomicWrite(it) { output -> input.copyTo(output) }
                }
            } else if (it.exists()) {
                if (!it.delete()) throw IOException("Could not remove pending secure file")
            }
        }
    }

    private val file: File
        get() = if (immediatelySave) source else temp

    val exists: Boolean
        get() = source.exists()

    fun input(block: (FileInputStream) -> Unit) {
        file.inputStream().use(block)
    }

    fun output(block: (FileOutputStream) -> Unit) {
        atomicWrite(file, block)
    }

    private fun atomicWrite(target: File, block: (FileOutputStream) -> Unit) {
        // Never truncate the committed file. This also protects against failed
        // authentication, encryption, disk writes and exceptions in the caller.
        val staging = File.createTempFile(".${source.name}.", ".tmp", source.parentFile)
        try {
            FileOutputStream(staging).use { output ->
                block(output)
                output.flush()
                output.fd.sync()
            }
            // Both paths are in the same directory. POSIX rename atomically
            // replaces the target, including when that target already exists.
            Os.rename(staging.absolutePath, target.absolutePath)
        } finally {
            staging.delete()
        }
    }

    fun readToBuffer(buffer: ByteArray): Int {
        var readByteCount = 0
        var totalByteCount = 0

        input {
            while (readByteCount != -1 && buffer.size > totalByteCount) {
                readByteCount = it.read(buffer, totalByteCount, buffer.size - totalByteCount)
                totalByteCount += readByteCount
            }
        }

        return totalByteCount
    }

    fun save() {
        temp.apply {
            if (exists()) {
                // Deferred writes have already been synced by atomicWrite.
                // Keep the pending file if promotion fails so it can be retried.
                Os.rename(absolutePath, source.absolutePath)
            }
        }
    }

    fun delete(): Boolean {
        val sourceDelete = if (source.exists()) source.delete() else true
        val tempDelete = if (temp.exists()) temp.delete() else true

        return sourceDelete && tempDelete
    }

    companion object {
        private fun ByteArray.toHexString(): String =
                joinToString(separator = "") { String.format("%02x", it) }
    }
}
