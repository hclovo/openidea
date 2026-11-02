# debugpy for the Python debugger

`debugpy-1.8.22-py2.py3-none-any.whl` is Microsoft's pure-Python debugpy wheel, unchanged. It is
embedded by `ide-tools` (registry entry `debugpy`, `Method::Bundled`) and unpacked into
`<tools>/debugpy/lib` the first time a Python debug session needs it and the interpreter has no
debugpy of its own (`ide-dap` `prepare_debugpy`). Like PyCharm's bundled debugger, it needs
neither pip nor network access, so hosts without `python3-pip` or PyPI access can debug too.

## Provenance

- Package: https://pypi.org/project/debugpy/1.8.22/
- File: https://files.pythonhosted.org/packages/56/3d/c7dc9f35bc9e22cdb53679f844bee40fd5cff871862f60595869a433400d/debugpy-1.8.22-py2.py3-none-any.whl
- SHA-256: `a9e9d3550e15ca479c59333e90845029190531f0cacfedab3b815a57bd913947`
- License: MIT (third-party notices inside the wheel, `debugpy/ThirdPartyNotices.txt`)

## Updating

Download the new `py2.py3-none-any` wheel from PyPI, check its SHA-256 against PyPI's, replace
the file here and update `filename`, `version` and the `include_bytes!` path of the `debugpy`
entry in `crates/ide-tools/src/registry.rs`. The wheel's file name is the unpacking stamp, so a
new version replaces older copies on the next debug session.
