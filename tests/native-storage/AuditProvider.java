public class AuditProvider extends java.security.Provider {
    public AuditProvider() {
        super("Audit", "1.0", "AES provider with simulated Keystore failures");
        put("Cipher.AuditAES", "AuditCipher");
    }
}
