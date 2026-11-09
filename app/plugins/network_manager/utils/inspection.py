"""Read-only IP normalization independent of native networking tools."""

import ipaddress


def normalize_address(record: dict) -> dict:
    result = {
        **record,
        "version": None,
        "prefix_length": None,
        "network_cidr": None,
        "network_address": None,
        "subnet_broadcast": None,
        "scope_id": None,
    }
    try:
        raw_address = record.get("address", "")
        address_text, _, scope = raw_address.partition("%")
        address = ipaddress.ip_address(address_text)
        result["version"] = address.version
        result["scope_id"] = scope or None
        raw_mask = record.get("netmask")
        if raw_mask is None or raw_mask == "":
            return result
        mask_text = str(raw_mask).removeprefix("/")
        width = address.max_prefixlen
        if mask_text.isdecimal():
            prefix = int(mask_text)
            if not 0 <= prefix <= width:
                return result
        else:
            mask = ipaddress.ip_address(mask_text)
            if mask.version != address.version:
                return result
            inverted = ((1 << width) - 1) ^ int(mask)
            # A valid mask has contiguous leading ones and trailing zeroes.
            if inverted & (inverted + 1):
                return result
            prefix = int(mask).bit_count()
        network = ipaddress.ip_network(f"{address}/{prefix}", strict=False)
        result.update({
            "prefix_length": prefix,
            "network_cidr": str(network),
            "network_address": str(network.network_address),
            "subnet_broadcast": (
                str(network.broadcast_address)
                if address.version == 4 and prefix < 31 else None
            ),
        })
    except (ValueError, TypeError, AttributeError):
        # Preserve OS-provided values even when no safe subnet can be derived.
        pass
    return result
