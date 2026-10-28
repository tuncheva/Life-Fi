"""Parses frame_sample.bin (written by test_csi_frame.exe) with the recorder's
parser: the Python side of the csi_frame_hdr_t contract must read back
exactly what the C side wrote."""

import base64
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "tools"))
import csi_recorder  # noqa: E402

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


packet = (pathlib.Path(__file__).parent / "frame_sample.bin").read_bytes()
parsed = csi_recorder.parse_frame(packet)
check(parsed is not None, "Python parses the C frame")
if parsed:
    hdr, data = parsed
    check(hdr["rssi_dbm"] == -67 and hdr["channel"] == 8 and hdr["rx_seq"] == 4321, "metadata")
    check(hdr["seq"] == 77 and hdr["boot_id"] == 0xCAFEBABE and hdr["ts_us"] == 0x0102030405060708, "counters")
    check(hdr["src_mac"] == "f0:33:e5:66:52:b0", "router MAC")
    check(hdr["csi_parts"] == 3 and len(data) == 256, "LLTF + HT-LTF, 256 bytes")
    check(data[0] == 0x80 and data[255] == 0x7F, "CSI bytes intact")
    csi = csi_recorder.lltf_complex(data, hdr["first_word_invalid"])
    # pair j holds [imag, real] = [2j - 128, 2j + 1 - 128]; column 0 is k = -26 (j = 38)
    check(len(csi) == 52 and csi[0] == complex(2 * 38 + 1 - 128, 2 * 38 - 128), "LLTF column order and [imag, real]")
    check(csi[26] == csi[27], "first_word_invalid repair matches the firmware")
line = (pathlib.Path(__file__).parent / "frame_line.txt").read_bytes().rstrip(b"\r\n")
check(line.startswith(csi_recorder.USB_PREFIX), "USB line starts with the recorder's prefix")
decoded = base64.b64decode(line[len(csi_recorder.USB_PREFIX):], validate=True)
check(decoded == packet, "USB line decodes to the identical frame")
print(f"\ncheck_csi_frame {'FAILED' if failures else 'PASSED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
