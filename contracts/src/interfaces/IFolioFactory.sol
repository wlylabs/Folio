// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @notice The slice of the factory a token needs at runtime.
 *
 * Declared as an interface rather than importing `FolioFactory` so the token and
 * the factory don't import each other in a cycle.
 */
interface IFolioFactory {
    /// @notice True while the platform-wide emergency stop is engaged.
    function paused() external view returns (bool);

    /// @notice True for tokens this factory created. The way to tell a genuine
    ///         launch from a clone somebody made of the implementation behind the
    ///         platform's back — `FolioMigrator` checks it before building a pool
    ///         for anything.
    function isFolioToken(address token) external view returns (bool);
}
