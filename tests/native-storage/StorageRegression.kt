import android.system.Os
import it.airgap.vault.plugin.securityutils.storage.Constants
import it.airgap.vault.plugin.securityutils.storage.SecureFile
import it.airgap.vault.plugin.securityutils.storage.SecureFileStorage
import java.io.File
import java.io.IOException
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.ProviderException
import java.security.Security
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.spec.SecretKeySpec
import javax.crypto.BadPaddingException
import javax.crypto.IllegalBlockSizeException
import javax.crypto.Cipher
import javax.crypto.CipherOutputStream
import javax.crypto.spec.IvParameterSpec

private val salt = ByteArray(32) { it.toByte() }
private val masterKey = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
private const val key = "wallet-v2-public-test-id"
private const val original = "Public test original wallet data"
private const val replacement = "Public test replacement wallet data"

private fun storedFile(directory: File): File {
    val hash = MessageDigest.getInstance("SHA-256").digest(salt + key.toByteArray())
    return File(directory, hash.joinToString("") { "%02x".format(it) })
}

private fun write(storage: SecureFileStorage, data: String, secret: ByteArray = byteArrayOf(),
                  onSuccess: () -> Unit = {},
                  authentication: ((Int, () -> Unit, () -> Unit) -> Unit)? = null): Exception? {
    val done = CountDownLatch(1)
    var failure: Exception? = null
    storage.write(key, data, secret, success = {
        try { onSuccess() } catch (error: Exception) { failure = error }
        done.countDown()
    }, error = {
        failure = it
        done.countDown()
    }, requestAuthentication = { attempt, retry, cancel ->
        try {
            check(authentication != null) { "Unexpected authentication request" }
            authentication(attempt, retry, cancel)
        } catch (error: Exception) {
            failure = error
            done.countDown()
        }
    })
    check(done.await(10, TimeUnit.SECONDS)) { "Write did not finish" }
    return failure
}

private fun read(storage: SecureFileStorage, secret: ByteArray = byteArrayOf()): String {
    val done = CountDownLatch(1)
    var result: String? = null
    var failure: Exception? = null
    storage.read(key, secret, success = { result = it; done.countDown() }, error = {
        failure = it; done.countDown()
    }, requestAuthentication = { _, _, cancel -> cancel() })
    check(done.await(10, TimeUnit.SECONDS)) { "Read did not finish" }
    failure?.let { throw it }
    return result!!
}

private fun noStagingFiles(directory: File) {
    check(directory.listFiles()!!.none { it.name.endsWith(".tmp") }) { "Failed write leaked a staging file" }
}

fun main(arguments: Array<String>) {
    Security.addProvider(AuditProvider())
    Constants.FILESYSTEM_CIPHER_ALGORITHM = "AuditAES"
    val root = File(arguments.single()).also { it.mkdirs() }
    fun case(name: String, body: (File) -> Unit) {
        AuditCipher.initCalls = 0
        AuditCipher.failInitAt = 0
        AuditCipher.finalCalls = 0
        AuditCipher.failFinalAt = 0
        AuditCipher.finalFailure = "provider"
        Os.failNextRename = false
        body(File(root, name).also { it.mkdirs() })
        println("PASS $name")
    }

    for (failedInit in 1..2) case("cancel-authentication-cipher-$failedInit") { directory ->
        val storage = SecureFileStorage(masterKey, salt, directory)
        val initial = write(storage, original)
        check(initial == null) { "Initial write failed: $initial" }
        val before = storedFile(directory).readBytes()
        AuditCipher.initCalls = 0
        AuditCipher.failInitAt = failedInit
        var prompted = false
        val error = write(storage, replacement, authentication = { attempt, _, cancel ->
            check(attempt == 1)
            check(storedFile(directory).readBytes().contentEquals(before)) {
                "Committed wallet changed before the authentication prompt"
            }
            prompted = true
            cancel()
        })
        check(prompted && error is android.security.keystore.UserNotAuthenticatedException) { "Authentication cancellation failed: $error" }
        check(storedFile(directory).readBytes().contentEquals(before)) { "Cancellation changed the committed wallet" }
        AuditCipher.failInitAt = 0
        check(read(SecureFileStorage(masterKey, salt, directory)) == original) // A new session can still open it.
        noStagingFiles(directory)
    }

    case("successful-authentication-retry") { directory ->
        val storage = SecureFileStorage(masterKey, salt, directory)
        check(write(storage, original) == null)
        AuditCipher.initCalls = 0
        AuditCipher.failInitAt = 1
        check(write(storage, replacement, authentication = { _, retry, _ ->
            AuditCipher.failInitAt = 0
            retry()
        }) == null)
        check(read(storage) == replacement)
        noStagingFiles(directory)
    }

    for (failure in listOf("provider", "bad-padding", "illegal-block-size")) {
        for (failedFinal in 1..2) case("cipher-finalization-$failure-layer-$failedFinal") { directory ->
            val storage = SecureFileStorage(masterKey, salt, directory)
            check(write(storage, original) == null)
            val before = storedFile(directory).readBytes()
            AuditCipher.finalCalls = 0
            AuditCipher.failFinalAt = failedFinal
            AuditCipher.finalFailure = failure
            var succeeded = false
            val error = write(storage, replacement, onSuccess = { succeeded = true })
            check(storedFile(directory).readBytes().contentEquals(before)) {
                "Cipher finalization failure replaced the committed wallet: $failure, layer $failedFinal"
            }
            check(!succeeded) { "Cipher finalization failure published success: $failure, layer $failedFinal" }
            check(when (failure) {
                "bad-padding" -> error is BadPaddingException
                "illegal-block-size" -> error is IllegalBlockSizeException
                else -> error is ProviderException
            }) { "Expected $failure from layer $failedFinal, received $error" }
            check(AuditCipher.finalCalls == failedFinal)
            AuditCipher.failFinalAt = 0
            check(read(storage) == original)
            noStagingFiles(directory)
        }
    }

    case("success-only-after-commit") { directory ->
        val storage = SecureFileStorage(masterKey, salt, directory)
        check(write(storage, original) == null)
        val before = storedFile(directory).readBytes()
        check(write(storage, replacement, onSuccess = {
            check(!storedFile(directory).readBytes().contentEquals(before)) { "Success was published before commit" }
        }) == null)
        check(read(storage) == replacement)
    }

    case("legacy-double-encryption-format-compatibility") { directory ->
        for ((index, secret) in listOf(byteArrayOf(), ByteArray(32) { 7 }).withIndex()) {
            val storeDirectory = File(directory, "legacy-format-$index").also { it.mkdirs() }
            val hash = MessageDigest.getInstance("SHA-256").digest(salt + key.toByteArray())
            val innerKey = SecretKeySpec(MessageDigest.getInstance("SHA-256").digest(secret + hash), "AES")
            val innerIv = IvParameterSpec(hash.copyOfRange(0, 16))
            val outer = Cipher.getInstance("AES/CBC/PKCS5Padding").apply { init(Cipher.ENCRYPT_MODE, masterKey) }
            val inner = Cipher.getInstance("AES/CBC/PKCS5Padding").apply { init(Cipher.ENCRYPT_MODE, innerKey, innerIv) }
            // Recreate the old nested-stream writer independently of the product writer.
            val legacy = ByteArrayOutputStream().also { it.write(outer.iv) }
            CipherOutputStream(CipherOutputStream(legacy, outer), inner).use { it.write(original.toByteArray()) }
            storedFile(storeDirectory).writeBytes(legacy.toByteArray())
            val storage = SecureFileStorage(masterKey, salt, storeDirectory)
            check(read(storage, secret) == original)
            check(write(storage, replacement, secret) == null)

            val committed = storedFile(storeDirectory).readBytes()
            outer.init(Cipher.DECRYPT_MODE, masterKey, IvParameterSpec(committed.copyOfRange(0, 16)))
            inner.init(Cipher.DECRYPT_MODE, innerKey, innerIv)
            val decrypted = inner.doFinal(outer.doFinal(committed.copyOfRange(16, committed.size)))
            check(decrypted.toString(Charsets.UTF_8) == replacement)
        }
    }

    case("partial-write-and-rename-failure") { directory ->
        val file = SecureFile(directory, "committed")
        file.output { it.write(original.toByteArray()) }
        try {
            file.output { it.write("partial".toByteArray()); throw IOException("Public test: disk failure") }
            error("Expected write failure")
        } catch (_: IOException) {}
        check(File(directory, "committed").readText() == original)
        Os.failNextRename = true
        try {
            file.output { it.write(replacement.toByteArray()) }
            error("Expected rename failure")
        } catch (_: IOException) {}
        check(File(directory, "committed").readText() == original)
        try {
            file.output { it.write(replacement.toByteArray()); it.close() } // Force fd.sync() to fail.
            error("Expected sync failure")
        } catch (_: IOException) {}
        check(File(directory, "committed").readText() == original)
        noStagingFiles(directory)
    }

    case("deferred-recovery-key-commit") { directory ->
        val source = File(directory, "recovery_key").also { it.writeText(original) }
        val file = SecureFile(directory, "recovery_key", immediatelySave = false)
        file.output { it.write(replacement.toByteArray()) }
        check(source.readText() == original)
        file.input { check(it.readBytes().toString(Charsets.UTF_8) == replacement) }
        try {
            file.output { it.write("partial".toByteArray()); throw IOException("Public test: disk failure") }
            error("Expected write failure")
        } catch (_: IOException) {}
        file.input { check(it.readBytes().toString(Charsets.UTF_8) == replacement) }
        Os.failNextRename = true
        try { file.save(); error("Expected promotion failure") } catch (_: IOException) {}
        check(source.readText() == original)
        file.input { check(it.readBytes().toString(Charsets.UTF_8) == replacement) }
        file.save()
        check(source.readText() == replacement)
        check(!File(directory, "recovery_key\$temp").exists())
        noStagingFiles(directory)
    }

    case("new-deferred-file-and-delete") { directory ->
        val file = SecureFile(directory, "recovery_key", immediatelySave = false)
        file.output { it.write(replacement.toByteArray()) }
        check(!file.exists)
        file.input { check(it.readBytes().toString(Charsets.UTF_8) == replacement) }
        file.save()
        check(file.exists)
        file.output { it.write("next snapshot".toByteArray()) }
        check(file.delete())
        check(directory.listFiles()!!.isEmpty())
    }

    case("normal-paranoia-recovery-roundtrips") { directory ->
        for ((index, secret) in listOf(byteArrayOf(), ByteArray(32) { 7 }).withIndex()) {
            val storeDirectory = File(directory, "normal-or-paranoia-$index").also { it.mkdirs() }
            val storage = SecureFileStorage(masterKey, salt, storeDirectory)
            check(write(storage, original, secret) == null)
            check(write(storage, replacement, secret) == null)
            check(read(storage, secret) == replacement)
            noStagingFiles(storeDirectory)
        }
        val recoveryDirectory = File(directory, "recovery").also { it.mkdirs() }
        val recoveryKey = SecretKeySpec(ByteArray(32) { 9 }, "AES")
        val recovery = SecureFileStorage(recoveryKey, salt, recoveryDirectory)
        check(write(recovery, original) == null)
        check(read(recovery) == original)
    }
}
