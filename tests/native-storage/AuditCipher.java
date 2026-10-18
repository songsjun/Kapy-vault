import java.security.*;
import java.security.spec.AlgorithmParameterSpec;
import javax.crypto.*;

/** Uses real AES; only Keystore authentication/failure boundaries are simulated. */
public class AuditCipher extends CipherSpi {
    public static int initCalls;
    public static int failInitAt;
    public static int finalCalls;
    public static int failFinalAt;
    public static String finalFailure;
    private final Cipher cipher;

    public AuditCipher() {
        try { cipher = Cipher.getInstance("AES/CBC/PKCS5Padding"); }
        catch (GeneralSecurityException error) { throw new ProviderException(error); }
    }
    private void authenticate() throws InvalidKeyException {
        if (++initCalls == failInitAt) {
            throw new android.security.keystore.UserNotAuthenticatedException();
        }
    }
    private void finalizeOrFail() throws IllegalBlockSizeException, BadPaddingException {
        if (++finalCalls != failFinalAt) return;
        switch (finalFailure) {
            case "bad-padding": throw new BadPaddingException("Public test: cipher padding failure");
            case "illegal-block-size": throw new IllegalBlockSizeException("Public test: cipher block size failure");
            default: throw new ProviderException("Public test: cipher finalization failed");
        }
    }
    protected void engineSetMode(String mode) {}
    protected void engineSetPadding(String padding) {}
    protected int engineGetBlockSize() { return cipher.getBlockSize(); }
    protected int engineGetOutputSize(int length) { return cipher.getOutputSize(length); }
    protected byte[] engineGetIV() { return cipher.getIV(); }
    protected AlgorithmParameters engineGetParameters() { return cipher.getParameters(); }
    protected void engineInit(int mode, Key key, SecureRandom random) throws InvalidKeyException {
        authenticate(); cipher.init(mode, key, random);
    }
    protected void engineInit(int mode, Key key, AlgorithmParameterSpec parameters, SecureRandom random)
            throws InvalidKeyException, InvalidAlgorithmParameterException {
        authenticate(); cipher.init(mode, key, parameters, random);
    }
    protected void engineInit(int mode, Key key, AlgorithmParameters parameters, SecureRandom random)
            throws InvalidKeyException, InvalidAlgorithmParameterException {
        authenticate(); cipher.init(mode, key, parameters, random);
    }
    protected byte[] engineUpdate(byte[] value, int offset, int length) {
        return cipher.update(value, offset, length);
    }
    protected int engineUpdate(byte[] value, int offset, int length, byte[] output, int position)
            throws ShortBufferException {
        return cipher.update(value, offset, length, output, position);
    }
    protected byte[] engineDoFinal(byte[] value, int offset, int length)
            throws IllegalBlockSizeException, BadPaddingException {
        finalizeOrFail();
        return value == null ? cipher.doFinal() : cipher.doFinal(value, offset, length);
    }
    protected int engineDoFinal(byte[] value, int offset, int length, byte[] output, int position)
            throws ShortBufferException, IllegalBlockSizeException, BadPaddingException {
        finalizeOrFail();
        return value == null ? cipher.doFinal(output, position) : cipher.doFinal(value, offset, length, output, position);
    }
}
