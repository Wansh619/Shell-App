import pytest

from app.plugins.network_manager.inspection import normalize_address


@pytest.mark.parametrize("address,mask,prefix,network,broadcast", [
    ("192.0.2.19", "255.255.255.0", 24, "192.0.2.0/24", "192.0.2.255"),
    ("192.0.2.19", "24", 24, "192.0.2.0/24", "192.0.2.255"),
    ("192.0.2.19", "255.255.255.255", 32, "192.0.2.19/32", None),
    ("192.0.2.18", "31", 31, "192.0.2.18/31", None),
    ("192.0.2.19", "0.0.0.0", 0, "0.0.0.0/0", "255.255.255.255"),
    ("2001:db8:abcd::1", "ffff:ffff:ffff:ffff::", 64, "2001:db8:abcd::/64", None),
    ("2001:db8::1", "/128", 128, "2001:db8::1/128", None),
    ("fe80::19%en0", "ffff:ffff:ffff:ffff::", 64, "fe80::/64", None),
])
def test_normalized_subnets(address, mask, prefix, network, broadcast):
    original = {"address": address, "netmask": mask, "family": "AF_INET"}
    result = normalize_address(original)
    assert result["address"] == address
    assert result["prefix_length"] == prefix
    assert result["network_cidr"] == network
    assert result["subnet_broadcast"] == broadcast
    assert "prefix_length" not in original
    if "%" in address:
        assert result["scope_id"] == "en0"


@pytest.mark.parametrize("address,mask", [
    ("192.0.2.1", "255.0.255.0"),
    ("192.0.2.1", "33"),
    ("192.0.2.1", "ffff:ffff::"),
    ("2001:db8::1", "255.255.255.0"),
    ("2001:db8::1", "ffff:0:ffff::"),
    ("192.0.2.1", None),
    ("not-an-ip", "24"),
    (None, "24"),
])
def test_unknown_or_invalid_masks_do_not_invent_subnets(address, mask):
    result = normalize_address({"address": address, "netmask": mask})
    assert result["address"] == address
    assert result["prefix_length"] is None
    assert result["network_cidr"] is None
