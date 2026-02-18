const { ethers } = require("hardhat");

async function main() {
  const TREASURY = "0x0Ad03C988D10D7e3A9FA1aC90c2cFAB6974Ef9a3";

  // ClankerFeeLocker v4.0.0 on Base mainnet
  const CLANKER_FEE_LOCKER = "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";

  console.log("Deploying ClaimRouter...");
  console.log("Treasury:", TREASURY);

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "ETH");

  const ClaimRouter = await ethers.getContractFactory("ClaimRouter");
  const router = await ClaimRouter.deploy(TREASURY);
  await router.waitForDeployment();

  const routerAddress = await router.getAddress();
  console.log("ClaimRouter deployed to:", routerAddress);

  // Allowlist the ClankerFeeLocker distributor
  console.log("Allowlisting ClankerFeeLocker:", CLANKER_FEE_LOCKER);
  const tx = await router.setDistributor(CLANKER_FEE_LOCKER, true);
  await tx.wait();
  console.log("ClankerFeeLocker allowlisted");

  // Verify current settings
  console.log("\n--- Deployment Summary ---");
  console.log("ClaimRouter:", routerAddress);
  console.log("Treasury:", TREASURY);
  console.log("Tax:", (await router.claimTaxBps()).toString(), "bps (3%)");
  console.log("ClankerFeeLocker allowed:", await router.allowedDistributors(CLANKER_FEE_LOCKER));
  console.log("Owner:", await router.owner());

  console.log("\n--- Verify on BaseScan ---");
  console.log(`npx hardhat verify --network base ${routerAddress} "${TREASURY}"`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
