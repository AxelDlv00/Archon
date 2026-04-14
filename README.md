# Archon : Simple CLI installation

> **Remark** : This repository is a fork from [Archon](https://github.com/frenzymath/Archon). This fork is not stable yet, it is currently being tested. 

## Installation 

To install the CLI tools and system dependencies, run the following command in your terminal:

```bash
curl -sSL https://raw.githubusercontent.com/AxelDlv00/Archon/refs/heads/main/install.sh | bash
```

> **Note**: A good practice is to run this in a Python environment. You need `python3` and `pip` installed on your system.

---

## Usage

Once installed, use the `archon` command to interact with the tools.

### Typical Workflow
1. **`archon setup`** : Install system-level dependencies.
2. **`archon init .`** : Initialize a new project with Lean 4.
3. **`archon loop .`** : Start the automated plan → prove → review loop.
4. **`archon dashboard .`** : Start the web dashboard for real-time monitoring.

### Commands Summary
| Command | Description |
| :--- | :--- |
| `init` | Initialize a new Archon project. |
| `loop` | Start the automated formalization loop. |
| `doctor` | Verify the full Archon setup and health. |
| `dashboard` | Start the web monitoring interface. |
| `prove` | Directly prove an inline statement. |
| `setup` | Install required system dependencies. |

*Run `archon --help` for details.*