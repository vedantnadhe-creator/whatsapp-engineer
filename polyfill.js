import crypto from 'crypto';

if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = crypto.webcrypto;
} else if (!globalThis.crypto.subtle && crypto.webcrypto) {
    globalThis.crypto.subtle = crypto.webcrypto.subtle;
    // ensure other webcrypto methods are also there if needed
    if (!globalThis.crypto.getRandomValues) {
        globalThis.crypto.getRandomValues = crypto.webcrypto.getRandomValues;
    }
}
