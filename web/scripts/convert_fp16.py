"""Convert an fp32 ONNX model to fp16 weights/compute for WebGPU delivery, keeping float32 graph I/O.

usage: python3 -I scripts/convert_fp16.py <in.onnx> <out.onnx> [--ops Op1,Op2] [--nodes name1,name2]

The exact commands for the shipped RTMPose fp16 builds are the `recipe` fields in web/models.lock.json. With
onnx==1.17.0 onnxconverter-common==1.16.0 numpy==2.0.2 protobuf==6.33.6 they reproduce the pinned sha256 byte for
byte (see scripts/README.md).

keep_io_types=True inserts Cast nodes at the graph boundary so the JS side keeps feeding float32 tensors.
--ops / --nodes keep overflow-prone parts in fp32 (e.g. RTMPose ScaleNorm = x*x -> ReduceSum -> Sqrt, and the GAU
squared-ReLU attention); mmdeploy NMS/TopK/shape ops are always kept in fp32.
"""
import sys
import onnx
from onnxconverter_common import float16

BASE_OPS = ["NonMaxSuppression", "TopK", "Range", "NonZero", "Shape", "ConstantOfShape", "Expand", "Tile", "Where",
            "Gather", "Less", "Equal", "ArgMax"]


def arg(flag):
    return sys.argv[sys.argv.index(flag) + 1].split(",") if flag in sys.argv else []


def main():
    src, dst = sys.argv[1], sys.argv[2]
    m = onnx.load(src)
    m16 = float16.convert_float_to_float16(m, keep_io_types=True, op_block_list=BASE_OPS + arg("--ops"),
                                           node_block_list=arg("--nodes"))
    onnx.save(m16, dst)
    onnx.checker.check_model(dst)
    print("wrote", dst)


if __name__ == "__main__":
    main()
