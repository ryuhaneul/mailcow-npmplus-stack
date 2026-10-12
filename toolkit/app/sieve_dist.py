"""Team distribution lines in a mailcow prefilter (Sieve script).

A mailbox is a "team" when its script has one or more top-level
``redirect :copy "<address>";`` commands; each of those is a member. The
functions here read the script with a minimal Sieve vocabulary (quoted strings,
``#`` and ``/* */`` comments, ``{ }`` depth, ``;``-terminated commands) and add
or remove exactly one member line, leaving every other byte as it was.

Anything outside that vocabulary (``text:`` strings, unbalanced brackets,
unterminated strings or comments, missing ``;``) makes the script
unparseable: ``analyze`` reports it and the edit functions refuse.
"""

import re

ADDRESS_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$")

_ID_START = re.compile(r"[A-Za-z_]")
_ID = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NUM = re.compile(r"[0-9]+[KkMmGg]?")
_OPEN = {"{": "}", "(": ")", "[": "]"}


class Unparseable(Exception):
    pass


class Refused(Exception):
    """A write that would not be safe. ``code`` is a stable machine-readable id."""

    def __init__(self, code, message=""):
        super().__init__(message or code)
        self.code = code


class Member:
    def __init__(self, address, start, end, simple, line_start, term_end, term):
        self.address = address
        self.start = start          # command span in the script
        self.end = end
        self.simple = simple        # alone on its line (a trailing # comment is ok)
        self.line_start = line_start
        self.term_end = term_end    # index just after the line terminator
        self.term = term            # "\n", "\r\n" or "" at end of script


class Analysis:
    def __init__(self):
        self.parsed = False
        self.reason = ""
        self.members = []
        self.forwards = []
        self.stopper_before_member = False

    @property
    def is_team(self):
        return self.parsed and bool(self.members)


def _tokenize(script):
    """Return tokens as (kind, value, start, end); raise Unparseable."""
    toks = []
    stack = []
    i, n = 0, len(script)
    while i < n:
        c = script[i]
        if c in " \t\r\n":
            i += 1
        elif c == "#":
            j = script.find("\n", i)
            i = n if j < 0 else j + 1
        elif c == "/":
            if script.startswith("/*", i):
                j = script.find("*/", i + 2)
                if j < 0:
                    raise Unparseable("unterminated comment")
                i = j + 2
            else:
                raise Unparseable("unexpected character")
        elif c == '"':
            j, buf = i + 1, []
            while True:
                if j >= n:
                    raise Unparseable("unterminated string")
                if script[j] == "\\":
                    if j + 1 >= n:
                        raise Unparseable("unterminated string")
                    buf.append(script[j + 1])
                    j += 2
                elif script[j] == '"':
                    break
                else:
                    buf.append(script[j])
                    j += 1
            toks.append(("str", "".join(buf), i, j + 1))
            i = j + 1
        elif c == ":":
            m = _ID.match(script, i + 1)
            if not m:
                raise Unparseable("unexpected character")
            toks.append(("tag", ":" + m.group(0).lower(), i, m.end()))
            i = m.end()
        elif _ID_START.match(c):
            m = _ID.match(script, i)
            if m.end() < n and script[m.end()] == ":":
                raise Unparseable("multi-line text or unsupported syntax")
            toks.append(("id", m.group(0).lower(), i, m.end()))
            i = m.end()
        elif c.isdigit():
            m = _NUM.match(script, i)
            toks.append(("num", m.group(0), i, m.end()))
            i = m.end()
        elif c in "{}()[],;":
            if c in _OPEN:
                stack.append(_OPEN[c])
            elif c in "})]":
                if not stack or stack.pop() != c:
                    raise Unparseable("unbalanced brackets")
            toks.append(("sym", c, i, i + 1))
            i += 1
        else:
            raise Unparseable("unexpected character")
    if stack:
        raise Unparseable("unbalanced brackets")
    return toks


def _top_level_commands(toks):
    """Group depth-0 tokens into commands: (name, args, start, end, is_block)."""
    cmds, cur = [], []
    depth = 0          # '{' nesting
    paren = 0          # '(' and '[' nesting
    for kind, val, s, e in toks:
        if kind == "sym":
            if val == "{":
                depth += 1
                if depth == 1:
                    cur.append((kind, val, s, e))
                continue
            if val == "}":
                depth -= 1
                if depth == 0:
                    cmds.append(_command(cur, e, True))
                    cur = []
                continue
        if depth > 0:
            continue
        if kind == "sym" and val in "([":
            paren += 1
        elif kind == "sym" and val in ")]":
            paren -= 1
        if kind == "sym" and val == ";":
            if paren:
                raise Unparseable("semicolon inside brackets")
            cmds.append(_command(cur, e, False))
            cur = []
            continue
        cur.append((kind, val, s, e))
    if cur:
        raise Unparseable("missing semicolon")
    return cmds


def _command(toks, end, is_block):
    if not toks or toks[0][0] != "id":
        raise Unparseable("command expected")
    args = toks[1:]
    if is_block and args and args[-1][:2] == ("sym", "{"):
        args = args[:-1]
    return (toks[0][1], args, toks[0][2], end, is_block)


def _line_info(script, s, e):
    """(simple, line_start, term_end, term) for the command spanning [s, e)."""
    line_start = script.rfind("\n", 0, s) + 1
    nl = script.find("\n", e)
    if nl < 0:
        line_end, term_end, term = len(script), len(script), ""
    else:
        line_end, term_end, term = nl, nl + 1, "\n"
        if nl > e and script[nl - 1] == "\r":
            line_end, term = nl - 1, "\r\n"
    prefix = script[line_start:s]
    rest = script[e:line_end].strip(" \t")
    simple = ("\n" not in script[s:e]
              and prefix.strip(" \t") == ""
              and (rest == "" or rest.startswith("#")))
    return simple, line_start, term_end, term


def analyze(script):
    """Read a Sieve script. Never raises; see Analysis.parsed / .reason."""
    a = Analysis()
    if not isinstance(script, str):
        a.reason = "script is not text"
        return a
    try:
        cmds = _top_level_commands(_tokenize(script))
    except Unparseable as e:
        a.reason = str(e)
        return a
    a.parsed = True
    stoppers = []
    for name, args, s, e, is_block in cmds:
        if is_block:
            continue
        kinds = [(t[0], t[1]) for t in args]
        has_copy = ("tag", ":copy") in kinds
        if name == "redirect" and len(kinds) == 2 and kinds[0] == ("tag", ":copy") \
                and kinds[1][0] == "str" and kinds[1][1] \
                and script[args[1][2] + 1:args[1][3] - 1] == kinds[1][1]:
            simple, ls, te, term = _line_info(script, s, e)
            a.members.append(Member(kinds[1][1], s, e, simple, ls, te, term))
            continue
        if name == "redirect" and len(kinds) == 1 and kinds[0][0] == "str":
            a.forwards.append(kinds[0][1])
        if name in ("stop", "discard") or (name in ("redirect", "fileinto") and not has_copy):
            stoppers.append(s)
    if a.members:
        last = a.members[-1].start
        a.stopper_before_member = any(p < last for p in stoppers)
    return a


def _writable(a):
    if not a.parsed:
        raise Refused("unparseable", a.reason)
    if not a.members:
        raise Refused("not_team", "no distribution lines in this script")


def _check(new, expected, code):
    b = analyze(new)
    if not b.parsed or [m.address.lower() for m in b.members] != expected:
        raise Refused(code, "edited script failed the self-check")


def add_member(script, address):
    """Return (new_script, changed). Insert after the last member line."""
    if not isinstance(address, str) or not ADDRESS_RE.match(address):
        raise Refused("invalid_address")
    a = analyze(script)
    _writable(a)
    current = [m.address.lower() for m in a.members]
    if address.lower() in current:
        return script, False
    if a.stopper_before_member:
        raise Refused("stopper_before_member")
    last = a.members[-1]
    if not last.simple:
        raise Refused("line_not_simple")
    indent = script[last.line_start:last.start]
    eol = last.term or "\n"
    line = f'{indent}redirect :copy "{address}";'
    if last.term:
        new = script[:last.term_end] + line + eol + script[last.term_end:]
    else:
        new = script + eol + line
    _check(new, current + [address.lower()], "self_check_failed")
    return new, True


def remove_member(script, address):
    """Return (new_script, changed). Delete the member line(s) for address."""
    if not isinstance(address, str) or not address:
        raise Refused("invalid_address")
    a = analyze(script)
    _writable(a)
    current = [m.address.lower() for m in a.members]
    target = address.lower()
    if target not in current:
        return script, False
    if all(c == target for c in current):
        raise Refused("last_member")
    if a.stopper_before_member:
        raise Refused("stopper_before_member")
    hits = [m for m in a.members if m.address.lower() == target]
    if not all(m.simple for m in hits):
        raise Refused("line_not_simple")
    new = script
    for m in reversed(hits):
        start = m.line_start
        if not m.term and start > 0:
            # last line without a terminator: drop the separator before it too
            start -= 2 if new[start - 2:start] == "\r\n" else 1
        new = new[:start] + new[m.term_end:]
    _check(new, [c for c in current if c != target], "self_check_failed")
    return new, True
