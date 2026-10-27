# Chrome permissions

Manifest source: `scripts/build.mjs`. Automated checks: `node scripts/audit.mjs`.

| Permission | Purpose |
| --- | --- |
| tabs | Read tab URL/title/state for organization, switching and URL recovery. |
| favicon | Display Chrome-provided site icons in tab trees and lists. |
| tabGroups | Inspect and manage native groups and their metadata. |
| storage | Keep local settings, session state and trusted-context configuration. |
| unlimitedStorage | Store local collections and attachments; physical memory/disk bounds still apply. |
| alarms | Schedule checkpoint, maintenance and optional sync reconciliation; timing is controlled by Chrome. |
| contextMenus | Save a link/tab or create a task through an explicit browser action. |
| sidePanel | Open the compact navigation and detail views in Chrome's side panel. |
| nativeMessaging (optional in TabSpace) | Connect the enabled Drag Group feature to its local Windows helper. |
| HTTPS host access (optional) | Connect only to a user-selected Nextcloud/WebDAV server after an origin-specific permission request. |

The manifest declares `optional_host_permissions: ["https://*/*"]` so users can enter their own HTTPS server. This is a request capability, not a blanket granted permission. Ordinary local organization needs no host grant. Content synchronized by the user is encrypted and sent to that chosen server.

No content scripts, scripting, browser history permission, externally connectable listener or developer-operated collection endpoint is used. The released TabSpace package does not replace Chrome's new-tab page. Local pages and CSP use bundled code. Incognito is not supported.

Standalone Drag Group has its own required `nativeMessaging`, `tabGroups` and `storage` permissions and no website host access. Its helper accepts only the packaged public extension identities. Public identity keys are not signing secrets.

See [privacy](PRIVACY.md) and the [security model](SECURITY.md).
