// Registers @testing-library/jest-dom matchers on Vitest's `expect` and pulls
// in the matching TypeScript augmentation so matchers like `toBeInTheDocument`
// are both available at runtime and type-checked by `tsc` during the build.
import '@testing-library/jest-dom/vitest'
