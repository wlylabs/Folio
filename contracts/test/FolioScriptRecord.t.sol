// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FolioScript} from "../script/FolioScript.sol";

/// @dev `recordedAddress` is internal, and the scripts that call it cannot be
///      driven from a test — `forge script` owns their lifecycle. A concrete
///      subclass with one external forwarder is the whole harness needed.
contract RecordReader is FolioScript {
    function read(string memory json, string memory key) external view returns (address) {
        return recordedAddress(json, key);
    }
}

/**
 * @title FolioScriptRecordTest
 * @notice The deployment record is read before a deploy, and a chain's record
 *         is committed with empty address fields before its first deploy ever
 *         runs. Those two facts meet in `recordedAddress`.
 *
 * The bug this pins down: `stdJson.readAddress` on `"factory": ""` does not
 * return zero, it aborts the script inside the address parser. Every path that
 * hit it did so on the first deploy to a new chain — the one run where there is
 * least reason to expect the tooling to be the thing that breaks.
 */
contract FolioScriptRecordTest is Test {
    RecordReader internal reader;

    /// @dev The shape `DeployFactory` writes, before it has written anything.
    string internal constant PLACEHOLDER = '{"network":"robinhood-testnet","chainId":46630,'
        '"factory":"","implementation":"","owner":"","lastToken":""}';

    /// @dev The same record after a deploy landed.
    string internal constant DEPLOYED = '{"network":"base-sepolia","chainId":84532,'
        '"factory":"0x3E4bAd5CD555A38DDcb67B37A13c4Df5D3785B07",'
        '"implementation":"0xD26eEf46360267645D8268aAF6FB715EaF634c52","lastToken":""}';

    function setUp() public {
        reader = new RecordReader();
    }

    function test_EmptyFieldReadsAsZero() public view {
        assertEq(reader.read(PLACEHOLDER, ".factory"), address(0));
        assertEq(reader.read(PLACEHOLDER, ".lastToken"), address(0));
    }

    function test_MissingKeyReadsAsZero() public view {
        assertEq(reader.read(PLACEHOLDER, ".nothingHere"), address(0));
    }

    function test_RecordedAddressIsReturned() public view {
        assertEq(reader.read(DEPLOYED, ".factory"), 0x3E4bAd5CD555A38DDcb67B37A13c4Df5D3785B07);
        assertEq(
            reader.read(DEPLOYED, ".implementation"),
            0xD26eEf46360267645D8268aAF6FB715EaF634c52
        );
    }

    /// @dev A live factory alongside a launch that has not happened yet is the
    ///      normal state of a fresh deploy, and the two fields must not share a
    ///      verdict: the trading scripts read `lastToken` and have to see
    ///      "none recorded" rather than inheriting the factory's success.
    function test_DeployedFactoryWithNoLaunchYet() public view {
        assertTrue(reader.read(DEPLOYED, ".factory") != address(0));
        assertEq(reader.read(DEPLOYED, ".lastToken"), address(0));
    }
}
