# Contributing to @horizon-republic/nestjs-jetstream

Thank you for your interest in contributing to this project! We welcome contributions from the community.

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- pnpm 10.12.1 or higher

### Setting Up Your Development Environment

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/your-username/nestjs-jetstream.git
   cd nestjs-jetstream
   ```

3. Install dependencies:
   ```bash
   pnpm install
   ```

4. Create a new branch for your feature or bugfix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

### Building the Project

```bash
pnpm build
```

To watch for changes during development:

```shell
pnpm build:watch
```

### Running Examples

```shell
# Build and run example
pnpm start:example

# Run example in development mode
pnpm dev:example
```

### Code Quality

Before submitting your changes, ensure your code passes linting:

```shell
# Check for linting issues
pnpm lint

# Automatically fix linting issues
pnpm lint:fix
```

### Testing

```shell
pnpm test
```

### Coding Standards

Follow the existing code style

* Use TypeScript for all new code
* Write clear, descriptive commit messages
* Add JSDoc comments for public APIs
* Ensure your code passes ESLint checks

### Commit Message Guidelines

We follow conventional commit messages format:

* feat: - A new feature
* fix: - A bug fix
* docs: - Documentation changes
* style: - Code style changes (formatting, etc.)
* refactor: - Code refactoring
* test: - Adding or updating tests
* chore: - Maintenance tasks

Example:

```shell
feat: add support for custom stream configuration
```

### Pull Request Process

1. Ensure your code builds without errors
2. Run linting and fix any issues
3. Update documentation if needed
4. Push your changes to your fork
5. Open a Pull Request with a clear description of your changes
6. Wait for review and address any feedback

### Code Review

All submissions require review before being merged. We'll review your PR and may suggest changes or improvements.

### Need Help?

* Open an issue for bug reports or feature requests
* Check existing issues before creating a new one
* Be respectful and constructive in all interactions

### License

By contributing, you agree that your contributions will be licensed under the MIT License.
Thank you for contributing! 🚀