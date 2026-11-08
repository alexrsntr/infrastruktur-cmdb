# Backlog

Status legend: 🟦 planned · 🟨 in progress · ✅ done

## Phase 2 – Switch & network documentation (requested)

### 🟦 B-1 Switch connection map per plant
Interactive network topology of a plant (and per building):

* Nodes = switches (grouped/layered by role: Core → Distribution → Access → Industrial/OT), optionally APs, servers and other endpoints.
* Edges = uplinks / connections from the CMDB relations, labelled with local and remote port (e.g. `Te1/1/1 ↔ Hu1/0/3`), LAG/port-channel shown as one bold link.
* Automatic hierarchical layout, zoom/pan, filter by building / role / VLAN, highlight path from an access switch to the core.
* Click a node → switch detail; click an edge → port details of both ends.
* Export as PNG / SVG / PDF and as Excel link list.
* Tech idea: React Flow or Cytoscape.js with ELK/dagre layout; data from `asset_relation` + new port table (B-2).

### 🟦 B-2 Port documentation
Structured documentation of every switch port instead of free-text ports on relations:

* New table `switch_port`: switch (asset), stack member, module, port index, name (`Gi1/0/12`), media (RJ45 / SFP / SFP+ / QSFP), speed, PoE (class / budget), mode (access / trunk / routed), access VLAN, allowed VLANs, LAG membership, description, admin/oper status, connected asset + remote port, patch panel / wall outlet (Dose), notes.
* Port templates per switch model (e.g. *C9300-48P = 48× RJ45 PoE+ + 4× SFP+ uplinks*, *SCALANCE XC216*) → ports are generated automatically when a switch is created.
* Bulk editing (select port range → set VLAN / description), Excel/CSV import & export, full change history per port.
* Relations between assets reference ports (`switch_port.id`) so the connection map and the faceplate stay consistent.

### 🟦 B-3 Switch stacking documentation
* Stack / virtual chassis entity: name, technology (StackWise, StackWise Virtual, VSF, IRF, VC), management IP, firmware.
* Members: member number, role (active / standby / member), priority, serial number, model, MAC, position in the rack.
* Stack cabling (ring topology: member ↔ member via stack ports) with validation of a closed ring.
* Port names automatically include the member number (`Gi2/0/14`).

### 🟦 B-4 Interactive switch UI (faceplate)
* SVG front panel rendered from the model template: ports arranged like the real hardware (odd ports top, even ports bottom, uplink module on the right).
* Stacks shown as stacked faceplates with member numbers.
* Colour modes: status (up / down / disabled), VLAN, PoE, "documented vs. free".
* Hover = tooltip (port, description, VLAN, connected device); **click = side drawer to view/edit the port** (editors), with link to the connected device.
* Multi-select ports with Shift/drag for bulk changes; legend; print view; export.

### 🟦 B-17 Cabling plans (rear view, cables coloured by network)
Requested from the Excel cabling designs used in server/storage projects (switch pair A/B, hypervisor hosts, storage with two nodes, one column per room). Instead of drawing by hand, the plan is generated from CMDB data and stays correct when something is re-plugged.

* **Ports on every device**, not only switches (extends B-2): server NICs (`A1/A2` OCP, `B1/B2` PCIe), iDRAC/iLO (`M1`), storage controller ports (`C1–C3`, `M1–M3`). Port templates per model (e.g. Dell PowerEdge R760, PowerStore), optionally a photo of the rear panel with the ports placed on it (same placement logic as site plans).
* **Cables** as records (new `cable` table): end A port, end B port, network/VLAN, cable type (DAC, AOC, Cat6a, fibre OM4/OS2), length, cable label, patch panels in between, status *planned / installed / removed*.
* **Networks** with name, VLAN ID and colour (a small first part of B-5) → legend and cable colours.
* **Plan view:** a saved plan per data center, room or cluster. Devices are arranged in columns (room 1 / room 2 or fabric A / B) and drawn as rear panels with labelled ports. Cables are routed at right angles and coloured by network; links between rooms run between the columns (fits the stretched data centers).
* **Interaction:** hover highlights a cable end to end, click shows both ends and the cable data, the legend switches networks on and off. Editors draw a cable by clicking port A, then port B. Planned cables are dashed until they are marked installed on site.
* **Checks:** port used twice, VLAN differs at both ends, server or storage node not connected to both switches of a pair, free ports.
* **Export / import:** PDF/PNG/SVG for handover documentation; Excel cable list (from device/port → to device/port, network, type, length, label). The same list can be imported from a partner's Excel so it does not have to be retyped.
* Every cable change appears in the activity log of both devices.
* Depends on B-2; shares the drawing code with B-4 and the data with B-1. Suggested order: **B-2 → B-17 → B-4 → B-1**.

## Phase 3 – Integrations (requested)

### 🟦 B-15 CheckMK integration (import hosts automatically)
* Read hosts from the **CheckMK REST API** (`/api/1.0/domain-types/host_config/collections/all`, plus service/host status from the monitoring API) per CheckMK site, with an automation user stored encrypted in *Settings* (like SMTP).
* Matching rules: CheckMK host name ↔ CMDB device name (case-insensitive), fall back to IP address; CheckMK folder → plant/building (configurable mapping table, e.g. folder `/muc/` → plant MUC).
* Daily sync job (same scheduler as the warranty e-mails) + "Sync now": creates **proposals** (new host, changed IP, host removed) that a local admin accepts with one click instead of silently overwriting data. Every accepted change appears in the device's activity log as "via CheckMK".
* Show live monitoring state (UP/DOWN, number of CRIT/WARN services, link "open in CheckMK") on the device page and in device lists.
* Later: push CMDB attributes (plant, building, rack, criticality) back as CheckMK host tags/labels.

### 🟦 B-16 MCP server for the CMDB
* Model Context Protocol server so that AI assistants can **query and update** the CMDB in natural language ("Which APs in Hall 1 have expiring warranty?", "Log a maintenance for muc-core-sw01").
* Tools: search devices, get device (incl. activity log), list racks/sites, log activity / note, (with confirmation) create or update a device; resources for plants and data centers.
* Auth with Entra ID (OAuth 2.1 for remote MCP); the same roles and plant scope as in the web app apply; every call is written to the audit log.
* Runs as a second endpoint of the same App Service (`/mcp`, streamable HTTP) – no extra infrastructure.

## Done recently

* ✅ Rack view (B-7), warranty e-mails (B-11), attachments (B-12)
* ✅ Site plans & pictures with device placement (plant pictures, aerial photos)
* ✅ Data centers stretched across two buildings: sites, site links (fibre/WAN), auto-generated diagram with cross-site connections and stretched clusters

## Later / ideas

| ID | Item | Notes |
|---|---|---|
| B-5 | VLAN & IP address management | VLAN registry per plant, subnets, IP usage, conflicts |
| B-6 | Auto-discovery import | Meraki Dashboard API, Cisco Catalyst Center, SNMP/LLDP, vCenter (VMs), Zabbix |
| ✅ B-7 | Rack elevation view | Done: racks per building, front view, devices + patch panels/UPS/PDU, mount/move/unmount, exports |
| B-8 | Patch panel documentation | Panels, outlets (Dosen), cabling to switch ports |
| B-9 | QR code labels | Printable labels linking to the asset page (mobile use on the shop floor) |
| B-10 | German UI (i18n) | DE/EN switch, German date & number formats already used |
| ✅ B-11 | Warranty e-mail notifications | Done: SMTP settings in the app (encrypted), daily digest per recipient/plant, preview, history. Still open: Teams channel, overdue activities |
| ✅ B-12 | Attachments | Done: files on plants/buildings/floors/racks/devices, picture gallery, ZIP download, Azure Blob Storage with managed identity. Open: server-side thumbnails, virus scanning (e.g. Defender for Storage) |
| B-13 | API tokens | Machine access for automation / scripts (Entra app-only tokens) |
| B-14 | Microsoft Graph user picker | Assignees and owners from Entra ID |
