"use strict";

// A Store route needs a verified publication contract and a receipt bound to
// the packaged extension. Until that contract exists, every build carries the
// temporary unpacked route and no ambient environment value can change it.
const PACKAGED_BRIDGE_DELIVERY = "developer_temporary";

module.exports = { PACKAGED_BRIDGE_DELIVERY };
