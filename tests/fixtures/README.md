`attention-client-ui1-conformance-v3.json` is the custom answer form (UI/1)
grammar corpus shared by Harklight Server and the Harklight iPhone app, copied
unchanged from Harklight Server's tests (SHA-256
`c616ceac8904ae4d12d66894a31971eeab8111d7d91bbe771489b49e6566f040`). The web
client gives the same verdicts when validating at the earlier fixed bounds
(`CORPUS_LIMITS`); its own bounds are the generous `WEB_LIMITS`.

`cover-2x2.avif` is the [Web Platform Tests green.avif sample](https://github.com/web-platform-tests/wpt/blob/28907950abfc7baf1cc61b5b9845f2a787032906/images/green.avif). Its [BSD-3-Clause notice](cover-2x2.avif.LICENSE.md) accompanies the file. It verifies that Chromium decodes the UI/1 illustration from its typed Blob. The browser tests cover the
stored AVIF type and the filename fallback for a migrated file. These tests
exercise AVIF decoding. HEIC decoding depends on browser support.
