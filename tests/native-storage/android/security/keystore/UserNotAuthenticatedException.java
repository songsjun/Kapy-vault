package android.security.keystore;

public class UserNotAuthenticatedException extends java.security.InvalidKeyException {
    public UserNotAuthenticatedException() { super("Public test: authentication expired"); }
}
