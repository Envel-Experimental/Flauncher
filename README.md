<p align="center"><img src="./app/assets/images/icon.png" width="150px" height="150px" alt="softworks"></p>

<h1 align="center">ФЛАУНЧЕР</h1>

[<p align="center"><img src="https://img.shields.io/github/actions/workflow/status/Envel-Experimental/Flauncher/build.yml?branch=master&style=for-the-badge" alt="gh actions">](https://github.com/Envel-Experimental/Flauncher/actions) [<img src="https://img.shields.io/github/downloads/Envel-Experimental/Flauncher/total.svg?style=for-the-badge" alt="downloads">](https://github.com/Envel-Experimental/Flauncher/releases)</p>

> **Disclaimer:** This software is a custom application manager designed for educational purposes. It does not contain, distribute, or bundle any third-party proprietary assets. The software is a tool for managing local environments. Users are solely responsible for ensuring they have the necessary rights to any third-party content they access through this tool.
>
> **Отказ от ответственности:** Данное программное обеспечение является специализированным менеджером приложений, разработанным в образовательных целях. Оно не содержит, не распространяет и не включает в себя сторонние проприетарные активы. Программа является инструментом для управления локальными средами. Пользователи несут единоличную ответственность за наличие необходимых прав на любой сторонний контент, доступ к которому осуществляется через данный инструмент.

## Development

This section details the setup of a basic development environment.

### Getting Started

**System Requirements**

* [Node.js](https://nodejs.org/en/) v20

---

**Clone and Install Dependencies**

```console
> git clone https://github.com/Envel-Experimental/Flauncher.git
> cd Flauncher
> npm install
```

---

**Launch Application**

```console
> npm start
```

---

**Build Installers**

To build for your current platform.

```console
> npm run dist
```

Build for a specific platform.

| Platform    | Command              |
| ----------- | -------------------- |
| Windows x64 | `npm run dist:win`   |
| macOS       | `npm run dist:mac`   |
| Linux x64   | `npm run dist:linux` |

---

## Testing

The project uses a multi-level testing strategy to ensure stability and prevent regressions.

| Level | Command | Description |
| :--- | :--- | :--- |
| **Unit** | `npm run test:unit` | Fast tests for individual logic modules. |
| **Integration** | `npm run test:integration` | Verifies interactions between services (e.g., Launcher orchestration). |
| **Smoke** | `npm run test:smoke` | Quick check if the app starts and reaches a functional state. |
| **E2E** | `npm run test:e2e` | Full user flow simulations using Playwright. |
| **Coverage** | `npm run test:coverage` | Generates a code coverage report for unit/integration tests. |

### CI/CD
Automated tests run on every push and pull request via [GitHub Actions](.github/workflows/test.yml).

---

### Visual Studio Code

All development should be done using [Visual Studio Code](https://code.visualstudio.com/).

Paste the following into `.vscode/launch.json`

```JSON
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Main Process",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}",
      "program": "${workspaceFolder}/node_modules/electron/cli.js",
      "args" : ["."],
      "outputCapture": "std"
    }
  ]
}
```