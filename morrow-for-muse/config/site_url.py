"""Browser-equivalent authority spelling for validated LMS addresses."""
import ipaddress


def canonical_netloc(parsed):
    if parsed.username is not None or parsed.password is not None:
        raise ValueError('LMS address must not embed credentials')
    host = parsed.hostname
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError('LMS address has an invalid port') from exc
    if (not host or port == 0 or any(ord(char) <= 32 or ord(char) == 127 for char in host)
            or any(char in host for char in ' #%/<>?@[\\]^|')
            or (':' in host and not parsed.netloc.startswith('['))):
        raise ValueError('LMS address has an invalid host or port')
    if parsed.netloc.startswith('['):
        host = '[' + str(ipaddress.IPv6Address(host)) + ']'
    elif not host.isascii():
        try:
            import idna
        except ImportError as exc:
            raise ValueError('Install requirements-optional.txt to use an international LMS address') from exc
        try:
            host = idna.encode(host, uts46=True, transitional=False).decode('ascii')
        except idna.IDNAError as exc:
            raise ValueError('LMS address has an invalid international host') from exc
    else:
        host = host.lower()
    if not host.startswith('['):
        last_label = host.rstrip('.').rsplit('.', 1)[-1]
        numeric_host = last_label.isdigit() or (
            last_label.startswith('0x')
            and all(char in '0123456789abcdef' for char in last_label[2:]))
        if numeric_host:
            try:
                host = str(ipaddress.IPv4Address(host))
            except ValueError as exc:
                raise ValueError('Use a full dotted-decimal IPv4 address for the LMS host') from exc
    if port is not None and port != {'http': 80, 'https': 443}.get(parsed.scheme):
        host += ':' + str(port)
    return host
