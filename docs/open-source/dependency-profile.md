# Community dependency profile

The local database uses better-sqlite3. The unused sqlite3 package and its optional native-build toolchain are not installed. SQLite aliases still resolve to the existing better-sqlite3 implementation; no database format or migration behavior is changed.

The application uses getNodeAutoInstrumentations but never the aggregate package's cloud resource-detector factory. A licensed local copy retains every instrumentation, ordering, explicit options and environment-variable selection from OpenTelemetry 0.81.0. All instrumentation implementations remain pinned to their previously installed versions. Only unused cloud-detector imports/export were removed. NodeSDK's existing resource detection is unchanged.

Five factory configurations were compared against the original upstream implementation before dependency removal. Regression fixtures preserve names, versions and effective configurations. Additional tests verify hook identity and absence of unused packages. Run npm run test:dependencies.

This removes the dependency paths containing GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249 without forcing incompatible glob/minimatch major versions. A clean dependency audit must still be repeated for any future lockfile update.

This is source for local self-hosting, not a signed production distribution. No production update feed or signing key is included. Existing-installation adoption, cross-schema upgrades, updater self-upgrade, Windows and production deployment remain unvalidated. Official relay DELETE/callback/error parity is incomplete. Real provider calls and external object storage are not part of synthetic validation. No successful production-release gate is implied.
