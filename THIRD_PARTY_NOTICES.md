# Third-party software

Third-party npm dependencies and exact versions are recorded in package-lock.json.
Their available copyright and license notices are retained in assets/licenses/npm/
with package metadata and source archive URLs in assets/licenses/npm-index.json.
The same files are distributed locally in the web assets under /licenses/.

ELK.js is distributed under EPL-2.0 (see its retained license); it is used without
modification. Source: https://github.com/kieler/elkjs and the exact release archive
specified in npm-index.json. React, Material UI, Emotion, Fastify, Ajv, fflate and
OpenType.js are used under their respective retained licenses.

The OpenGOST type B font is distributed under SIL Open Font License 1.1. See
assets/fonts/LICENSE.txt, FONTLOG.txt and PROVENANCE.md. Its unmodified font bytes
are also included as Base64 in packages/core/src/font-data.ts for portable SVG.

Node.js and the Docker base image retain their own distribution notices. No
third-party service, telemetry, cloud font, API key or AI subscription is required
to run this application after initial installation.
