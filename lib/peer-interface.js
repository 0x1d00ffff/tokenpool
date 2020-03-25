
// var redis = require("redis");
var jayson = require('jayson')

var web3utils = require('web3-utils')

var peerUtils = require('./peer-utils')

var deployedContractInfo = require('../app/assets/contracts/DeployedContractInfo.json')

const UPDATE_VAR_DIFF_PERIOD = 30 * 1000 // 30 seconds

module.exports = {

  async init (web3, accountConfig, poolConfig, redisInterface, mongoInterface, tokenInterface, pool_env) {
    this.pool_env = pool_env
    this.web3 = web3
    this.accountConfig = accountConfig
    this.poolConfig = poolConfig

    this.redisInterface = redisInterface
    this.mongoInterface = mongoInterface

    this.tokenInterface = tokenInterface

    if (this.poolConfig.poolTokenFee == null) {
      console.log('Please set a poolTokenFee (% of tokens as a pool fee)')
      exit()
      return
    }

    if (this.poolConfig.communityTokenFee == null) {
      this.poolConfig.communityTokenFee = 0
    }
  },

  async listenForJSONRPC () {
    this.initJSONRPCServer()
  },

  async update () {
    var self = this

    setTimeout(function () { self.processQueuedShares() }, 0)

    setTimeout(function () { self.monitorMinedSolutions() }, 0)

    // Error

    setTimeout(function () { self.updateVariableDifficultyPeriod() }, 0)
  },

  getPoolMinimumShareDifficulty () {
    return this.poolConfig.minimumShareDifficulty
  },

  getPoolMaximumShareDifficulty () {
    return this.poolConfig.maximumShareDifficulty
  },

  async getMinerVarDiff (minerEthAddress) {
    if (minerEthAddress == null || typeof minerEthAddress === 'undefined' || !web3utils.isAddress(minerEthAddress)) {
      var poolMinDiff = this.getPoolMinimumShareDifficulty()
      return poolMinDiff
    }

    minerEthAddress = minerEthAddress.toString().toLowerCase()

    var sharesData = await this.getSharesData(minerEthAddress)

    var varDiff = 1

    if (sharesData) {
      varDiff = sharesData.varDiff

      if (varDiff < this.getPoolMinimumShareDifficulty()) {
        varDiff = this.getPoolMinimumShareDifficulty()
      }
    }

    return varDiff
  },

  getPoolMinimumShareTarget (diff) // compute me
  {
    if (diff == null) {
      diff = this.getPoolMinimumShareDifficulty()
    }
    return this.getTargetFromDifficulty(diff)
  },

  getTargetFromDifficulty (difficulty) {
    var max_target
    if (this.pool_env == 'test') {
      max_target = web3utils.toBN(2).pow(web3utils.toBN(244))
    } else {
      max_target = web3utils.toBN(2).pow(web3utils.toBN(234))
    }
    var current_target = max_target.div(web3utils.toBN(difficulty))
    return current_target
  },

  /*
    This is the gatekeeper for solution submits
    TODO: this pops values off queued_shares_list, which is gated by submitShare(). If
          we were to store a validShare key with shareData, then we would not need to
          recalculate the digest again here.
   */
  async handlePeerShareSubmit (nonce, minerEthAddress, challengeNumber, digest, difficulty, customVardiff) {
    console.log('handlePeerShareSubmit: new share from', minerEthAddress, nonce)

    if (difficulty == null) return
    if (nonce == null) return
    if (minerEthAddress == null) return
    if (challengeNumber == null) return
    if (digest == null) return

    var poolEthAddress = this.getMintHelperAddress()
    var poolChallengeNumber = await this.tokenInterface.getPoolChallengeNumber()
    var computed_digest = web3utils.soliditySha3(poolChallengeNumber, poolEthAddress, nonce)
    var digestBigNumber = web3utils.toBN(computed_digest)
    var miningTarget = web3utils.toBN(await this.tokenInterface.getPoolDifficultyTarget())
    var claimedTarget = this.getTargetFromDifficulty(difficulty)
    var varDiff = await this.getMinerVarDiff(minerEthAddress)

    /*
      SHOULD BE USING THE PARAMETER customVardiff  BUT WILL WAIT FOR MINERS TO IMPLEMENT
     */
    var usingCustomDifficulty = (difficulty != varDiff)

    var minShareDifficulty = this.getPoolMinimumShareDifficulty()

    if (computed_digest === digest &&
       difficulty >= minShareDifficulty &&
       digestBigNumber.lt(claimedTarget)) {
      var shareIsASolution = digestBigNumber.lt(miningTarget)

      return await this.handleValidShare(nonce,
        minerEthAddress,
        digest,
        difficulty,
        shareIsASolution,
        usingCustomDifficulty)
    } else {
      if (computed_digest !== digest) console.log('handlePeerShareSubmit: bad digest ', computed_digest, digest)
      if (difficulty < minShareDifficulty) console.log('handlePeerShareSubmit: bad diff ', difficulty, minShareDifficulty)
      if (digestBigNumber.lt(claimedTarget) == false) console.log('handlePeerShareSubmit: not less than target ', claimedTarget)

      var ethBlock = await this.redisInterface.getEthBlockNumber()

      var shareData = {
        block: ethBlock,
        nonce: nonce,
        miner: minerEthAddress,
        difficulty: difficulty,
        time: peerUtils.getUnixTimeNow()
      }

      // await this.redisInterface.storeRedisHashData("invalid_share", digest , JSON.stringify(shareData))
      await this.redisInterface.pushToRedisList('miner_invalid_share:' + minerEthAddress.toString().toLowerCase(), JSON.stringify(shareData))

      return { success: false, message: 'This share digest is invalid' }
    }
  },

  async  handleValidShare (nonce, minerEthAddress, digest, difficulty, shareIsASolution, usingCustomDifficulty) {
    console.log('handleValidShare: handle valid share ')
    var existingShare = await this.redisInterface.findHashInRedis('submitted_share', digest)

    // make sure we have never gotten this digest before (redis )
    if (existingShare == null && minerEthAddress != null) {
      var timeToFindShare
      var ethBlock = await this.redisInterface.getEthBlockNumber()
      var minerData = await this.getMinerData(minerEthAddress.toString().toLowerCase())

      minerData.usingCustomDifficulty = usingCustomDifficulty

      await this.saveMinerDataToRedisMongo(minerEthAddress, minerData)

      /* TODO: this is always null... isn't lastSubmittedSolutionTime stored in sharesData
               instead of minerData? Needs testing. */
      if (minerData.lastSubmittedSolutionTime != null) {
        timeToFindShare = (peerUtils.getUnixTimeNow() - minerData.lastSubmittedSolutionTime)
      } else {
        // make sure we check for this later
        timeToFindShare = 0
      }

      var difficultyBN = web3utils.toBN(difficulty)

      var shareData = {
        block: ethBlock,
        nonce: nonce,
        miner: minerEthAddress,
        difficulty: difficulty,
        isSolution: shareIsASolution,
        hashRateEstimate: this.getEstimatedShareHashrate(difficultyBN, timeToFindShare),
        time: peerUtils.getUnixTimeNow(),
        timeToFind: timeToFindShare // helps estimate hashrate- look at recent shares
      }

      // make sure this is threadsafe
      await this.redisInterface.storeRedisHashData('submitted_share', digest, JSON.stringify(shareData))
      await this.redisInterface.pushToRedisList('miner_submitted_share:' + minerEthAddress.toString().toLowerCase(), JSON.stringify(shareData))
      await this.redisInterface.pushToRedisList('submitted_shares_list', JSON.stringify(shareData))

      if (shareIsASolution) {
        await this.redisInterface.pushToRedisList('submitted_solutions_list', JSON.stringify(shareData))
      }

      var shareCredits = await this.getShareCreditsFromDifficulty(difficulty, shareIsASolution)

      await this.awardShareCredits(minerEthAddress, shareCredits)

      var challengeNumber = await this.tokenInterface.getPoolChallengeNumber()

      if (shareIsASolution) {
        console.log('handleValidShare: share is a solution! ')
        this.tokenInterface.queueMiningSolution(nonce, minerEthAddress, digest, challengeNumber)
      } else {
        console.log('handleValidShare: share is not a solution! ')
      }

      return { success: true, message: 'New share credited successfully' }
    } else {
      return { success: false, message: 'This share digest was already received' }
    }
  },

  /*
    This does avg hashrate calcs and the vardiff
  */
  async updateVariableDifficultyPeriod () {
    var self = this
    console.log('updateVariableDifficultyPeriod: Update Vardiff')

    var minerList = await this.getMinerList()

    for (const i in minerList) {
      var minerAddress = minerList[i]
      var sharesData = await this.getSharesData(minerAddress)
      if (sharesData == null) continue

      var newVarDiff = await this.getUpdatedVarDiffForMiner(sharesData, minerAddress)

      sharesData.hashRate = await this.estimateMinerHashrate(minerAddress)
      sharesData.varDiff = newVarDiff
      sharesData.validSubmittedSolutionsCount = 0 // reset

      await this.saveSharesData(minerAddress, sharesData)
    }
    setTimeout(function () { self.updateVariableDifficultyPeriod() }, UPDATE_VAR_DIFF_PERIOD) // 1 minute
  },

  // TimeToSolveBlock (seconds) = difficulty * 2^22 / hashrate (hashes per second)
  // hashrate = (difficulty * 2^22) / timeToSolveABlock seconds)
  getEstimatedShareHashrate (difficulty, timeToFindSeconds) {
    if (timeToFindSeconds != null && timeToFindSeconds > 0) {
      var hashrate = web3utils.toBN(difficulty).mul(web3utils.toBN(2).pow(web3utils.toBN(22))).div(web3utils.toBN(timeToFindSeconds))
      return hashrate.toNumber() // hashes per second
    } else {
      return 0
    }
  },

  async estimateMinerHashrate (minerAddress) {
    try {
      var submitted_shares = await this.redisInterface.getParsedElementsOfListInRedis(('miner_submitted_share:' + minerAddress.toString().toLowerCase()), 20)

      if (submitted_shares == null || submitted_shares.length < 1) {
        console.log(`estimateMinerHashrate:${minerAddress}: no submitted shares`)
        return 0
      }

      var totalDiff = web3utils.toBN(0)
      var CUTOFF_MINUTES = 90
      var cutoff = peerUtils.getUnixTimeNow() - (CUTOFF_MINUTES * 60)

      // the most recent share seems to be at the front of the list
      // TODO: verify this / remove this requirement
      var recentShareCount = 0
      while (recentShareCount < submitted_shares.length && submitted_shares[recentShareCount].time > cutoff) {
        var diffDelta = submitted_shares[recentShareCount].difficulty

        if (isNaN(diffDelta)) diffDelta = 0

        totalDiff = totalDiff.add(web3utils.toBN(diffDelta))
        recentShareCount++
      }

      if (recentShareCount < 2) {
        //  console.log('no recent submitted shares')
        return 0
      }

      var seconds = submitted_shares[0].time - submitted_shares[recentShareCount - 1].time
      if (seconds == 0) {
        console.log(`estimateMinerHashrate:${minerAddress}: ${recentShareCount} shares have no time between`)
        return 0
      }

      var hashrate = this.getEstimatedShareHashrate(totalDiff, seconds)
      console.log(`estimateMinerHashrate:${minerAddress.slice(0, 10)}..: shares:${recentShareCount} diff:${totalDiff} seconds:${seconds} rate:${hashrate}`)
      return hashrate.toString()
    } catch (err) {
      console.log(`estimateMinerHashrate:${minerAddress}: caught error ${err}`)
      return 0
    }
  },

  /* TODO: this is broken for now, because 'share.timeToFind' is 0 for all shares. Need
           to investigate  */
  async getAverageSolutionTime (minerAddress) {
    if (minerAddress == null) return null

    var submitted_shares = await this.redisInterface.getRecentElementsOfListInRedis(('miner_submitted_share:' + minerAddress.toString().toLowerCase()), 3)

    var sharesCount = 0

    if (submitted_shares == null || submitted_shares.length < 1) {
      return null
    }

    var summedFindingTime = 0

    for (var i = 0; i < submitted_shares.length; i++) {
      var share = submitted_shares[i]

      var findingTime = parseInt(share.timeToFind)

      if (!isNaN(findingTime) && findingTime > 0 && findingTime != null) {
        summedFindingTime += findingTime
        sharesCount++
      }
    }

    if (sharesCount <= 0) {
      return null
    }

    var timeToFind = Math.floor(summedFindingTime / sharesCount)
    return timeToFind
  },

  // we expect a solution per minute ??
  async getUpdatedVarDiffForMiner (sharesData, minerAddress) {
    var minerVarDiff = sharesData.varDiff
    var poolMinDiff = this.getPoolMinimumShareDifficulty()
    var poolMaxDiff = this.getPoolMaximumShareDifficulty()

    var avgFindingTime = await this.getAverageSolutionTime(minerAddress)

    // dont modify if using custom
    if (sharesData.usingCustomDifficulty) {
      console.log(`getUpdatedVarDiffForMiner: ${minerAddress.slice(0, 10)}: using custom val ${minerVarDiff}`)
      return minerVarDiff
    }

    sharesData.avgFindingTime = avgFindingTime

    var expectedFindingTime = 60// seconds

    console.log(`getUpdatedVarDiffForMiner: ${minerAddress.slice(0, 10)}: diff:${minerVarDiff} avgtime:${avgFindingTime} sols:${sharesData.validSubmittedSolutionsCount}`)
    if (sharesData.validSubmittedSolutionsCount > 0 && avgFindingTime != null) {
      if (avgFindingTime < expectedFindingTime * 0.9) {
        minerVarDiff = Math.ceil(minerVarDiff * 1.2) // harder
      } else if (avgFindingTime > expectedFindingTime * 1.1) {
        minerVarDiff = Math.ceil(minerVarDiff / 1.2) // easier
      }
    }

    if (minerVarDiff < poolMinDiff) {
      minerVarDiff = poolMinDiff
    }

    if (minerVarDiff > poolMaxDiff) {
      minerVarDiff = poolMaxDiff
    }

    console.log(`getUpdatedVarDiffForMiner: ${minerAddress.slice(0, 10)}: updated diff:${minerVarDiff}`)
    return minerVarDiff
  },

  async processQueuedShares () {
    var self = this
    var shareDataJSON = await this.redisInterface.popFromRedisList('queued_shares_list')
    var shareData = JSON.parse(shareDataJSON)

    if (typeof shareData !== 'undefined' && shareData != null) {
      try {
        await self.handlePeerShareSubmit(shareData.nonce, shareData.minerEthAddress, shareData.challengeNumber, shareData.digest, shareData.difficulty, shareData.customVardiff)
      } catch (err) {
        console.log('processQueuedShares: handle share error: ', err)
      }
    }
    setTimeout(function () { self.processQueuedShares() }, 0)
  },

  async cleanRedisData () {
    var self = this

    // loop through each miner
    var minerList = await self.getMinerList()

    console.log('cleanRedisData: remove extra data for ', minerList.length, ' miners ')
    for (const i in minerList) {
      var minerEthAddress = minerList[i]

      if (minerEthAddress == null) continue

      await this.redisInterface.removeFromRedisListToLimit('miner_invalid_share:' + minerEthAddress.toString().toLowerCase(), 50)
      await this.redisInterface.removeFromRedisListToLimit('submitted_shares_list', 50)
      await this.redisInterface.removeFromRedisListToLimit('miner_submitted_share:' + minerEthAddress.toString().toLowerCase(), 400)
    }

    var currentEthBlock = await this.redisInterface.getEthBlockNumber()

    var DIGESTS_LIFETIME_BLOCKS = 1000

    var submittedSharesKeys = await this.redisInterface.getResultsOfKeyInRedis('submitted_share')

    for (const i in submittedSharesKeys) {
      var digest = submittedSharesKeys[i]
      var submittedShareDataJSON = await this.redisInterface.findHashInRedis('submitted_share', digest)
      var submittedShareData = JSON.parse(submittedShareDataJSON)

      if (submittedShareData.block < (currentEthBlock - DIGESTS_LIFETIME_BLOCKS)) {
        await this.redisInterface.deleteHashInRedis('submitted_share', digest)
      }
    }

    console.log('cleanRedisData: done!!')

    // setTimeout(function(){self.cleanRedisData()},60 * 1000)
  },

  async monitorMinedSolutions () {
    var self = this

    try {
      var solution_txes = await this.redisInterface.getResultsOfKeyInRedis('unconfirmed_submitted_solution_tx')
      if (solution_txes != null && solution_txes.length > 0) {
        console.log(`monitorMinedSolutions: ${solution_txes.length} txs`)
        await this.checkMinedSolutions(solution_txes)
      }
    } catch (e) {
      console.log('monitorMinedSolutions: error', e)
    }
    setTimeout(function () { self.monitorMinedSolutions() }, 4000)
  },

  async requestTransactionReceipt (tx_hash) // not working
  {
    try {
      var receipt = await this.web3.eth.getTransactionReceipt(tx_hash)
    } catch (err) {
      console.error('requestTransactionReceipt[NOT WORKING]: could not find receipt ', tx_hash)
      return null
    }
    return receipt
  },

  // checks each to see if they have been mined
  async checkMinedSolutions (solution_txes) {
    for (const i in solution_txes) {
      var tx_hash = solution_txes[i]

      var txDataJSON = await this.redisInterface.findHashInRedis('unconfirmed_submitted_solution_tx', tx_hash)
      var transactionData = JSON.parse(txDataJSON)

      if (transactionData.mined == false) {
        var liveTransactionReceipt = await this.requestTransactionReceipt(tx_hash)

        if (liveTransactionReceipt != null) {
          console.log('checkMinedSolutions: got receipt', liveTransactionReceipt)
          transactionData.mined = true

          var transaction_succeeded = ((liveTransactionReceipt.status == true) ||
                                       (web3utils.hexToNumber(liveTransactionReceipt.status) == 1))
          if (transaction_succeeded) {
            transactionData.succeeded = true
            console.log('checkMinedSolutions: transaction was mined and succeeded', tx_hash)
          } else {
            console.log('checkMinedSolutions: transaction was mined and failed', tx_hash)
          }

          await this.redisInterface.deleteHashInRedis('unconfirmed_submitted_solution_tx', tx_hash)
          // save as confirmed
          await this.saveSubmittedSolutionTransactionData(tx_hash, transactionData)
        } else {
          console.log('checkMinedSolutions: got null receipt', tx_hash)
        }
      }

      if (transactionData.mined == true && transactionData.succeeded == true && transactionData.rewarded == false) {
        console.log('checkMinedSolutions: found unrewarded successful transaction ! ', tx_hash)
        await this.grantTokenBalanceRewardForTransaction(tx_hash, transactionData)
        transactionData.rewarded = true
        await this.saveSubmittedSolutionTransactionData(tx_hash, transactionData)
      }
    }
  },

  async getBalanceTransferConfirmed (paymentId) {
    // check balance payment

    var balanceTransferJSON = await this.redisInterface.findHashInRedis('balance_transfer', paymentId)
    var balanceTransfer = JSON.parse(balanceTransferJSON)

    if (balanceTransferJSON == null || balanceTransfer.txHash == null) {
      return false
    } else {
      // dont need to check receipt because we wait many blocks between broadcasts - enough time for the monitor to populate this data correctly
      return balanceTransfer.confirmed
    }
  },

  async saveSubmittedSolutionTransactionData (tx_hash, transactionData) {
    await this.redisInterface.storeRedisHashData('submitted_solution_tx', tx_hash, JSON.stringify(transactionData))
    await this.redisInterface.pushToRedisList('submitted_solutions_list', JSON.stringify(transactionData))
  },

  async loadStoredSubmittedSolutionTransaction (tx_hash) {
    var txDataJSON = await this.redisInterface.findHashInRedis('submitted_solution_tx', tx_hash)
    var txData = JSON.parse(txDataJSON)
    return txData
  },

  async grantTokenBalanceRewardForTransaction (tx_hash, transactionData) {
    var reward_amount = transactionData.token_quantity_rewarded

    var total_fees_raw = (this.poolConfig.poolTokenFee + this.poolConfig.communityTokenFee)

    var fee_percent = total_fees_raw / 100.0

    if (fee_percent > 1.0) fee_percent = 1.0
    if (fee_percent < 0) fee_percent = 0.0

    // remember collected fees
    var reward_amount_for_pool = Math.floor(reward_amount * (this.poolConfig.poolTokenFee / 100.0))
    var reward_amount_for_community = Math.floor(reward_amount * (this.poolConfig.communityTokenFee / 100.0))

    var poolFeeTokens = await this.redisInterface.loadRedisData('totalPoolFeeTokens')
    var communityFeeTokens = await this.redisInterface.loadRedisData('totalCommunityFeeTokens')

    if (poolFeeTokens == null)poolFeeTokens = 0
    if (communityFeeTokens == null)communityFeeTokens = 0

    await this.redisInterface.storeRedisData('totalPoolFeeTokens', poolFeeTokens + reward_amount_for_pool)
    await this.redisInterface.storeRedisData('totalCommunityFeeTokens', communityFeeTokens + reward_amount_for_community)

    var reward_amount_for_miners = Math.floor(reward_amount - (reward_amount * fee_percent))

    var total_shares = await this.getTotalMinerShares()

    var minerList = await this.getMinerList()

    console.log('grantTokenBalanceAwardForTransaction: granting ' + reward_amount + ' awards to ', minerList.length)

    for (var i in minerList) // reward each miner
    {
      var minerAddress = minerList[i]

      var minerData = await this.getMinerData(minerAddress)
      var sharesData = await this.getSharesData(minerAddress)

      if (minerData == null) continue
      if (sharesData == null) continue

      console.log('grantTokenBalanceAwardForTransaction: minerData', minerData)

      var miner_shares = sharesData.shareCredits

      var miner_percent_share = parseFloat(miner_shares) / parseFloat(total_shares)

      if (isNaN(miner_percent_share)) {
        miner_percent_share = 0
      }

      console.log('grantTokenBalanceAwardForTransaction: miner_percent_share', miner_percent_share) // nan

      var tokensOwed = Math.floor(reward_amount_for_miners * miner_percent_share) // down to 8 decimals

      console.log('grantTokenBalanceAwardForTransaction: tokensOwed', tokensOwed)

      // Update the miners current token balance

      var newTokenBalance = parseInt(minerData.tokenBalance)

      if (isNaN(newTokenBalance)) { newTokenBalance = 0 }

      console.log('grantTokenBalanceAwardForTransaction: newTokenBalance', newTokenBalance)
      newTokenBalance += tokensOwed

      minerData.tokenBalance = newTokenBalance

      // Update the miners total token balance

      var newAlltimeTokenBalance = parseInt(minerData.alltimeTokenBalance)

      if (isNaN(newAlltimeTokenBalance)) { newAlltimeTokenBalance = 0 }

      newAlltimeTokenBalance += tokensOwed
      minerData.alltimeTokenBalance = newAlltimeTokenBalance

      console.log('grantTokenBalanceAwardForTransaction: newAlltimeTokenBalance', newAlltimeTokenBalance)

      // Zero out share credits

      sharesData.shareCredits = 0 // wipe old shares

      console.log('grantTokenBalanceAwardForTransaction: tokenBalance', minerData.tokenBalance)

      await this.saveMinerDataToRedisMongo(minerAddress, minerData)
      await this.saveSharesData(minerAddress, sharesData)

      //   var minerShares = minerData.
    }

    console.log('grantTokenBalanceAwardForTransaction: finished granting tokens owed ')
  },

  async getShareCreditsFromDifficulty (difficulty, shareIsASolution) {
    var minShareDifficulty = this.getPoolMinimumShareDifficulty()
    var amount

    if (shareIsASolution || difficulty >= minShareDifficulty) {
      amount = Math.floor(difficulty)
      return amount
    }
    console.log('getShareCreditsFromDifficulty: no shares for this solve!!', difficulty, minShareDifficulty)
    return 0
  },

  async awardShareCredits (minerEthAddress, shareCredits) {
    console.log('awardShareCredit: awarding shares:', shareCredits)
    var sharesData = await this.getSharesData(minerEthAddress)

    if (sharesData.shareCredits == null || isNaN(sharesData.shareCredits)) sharesData.shareCredits = 0
    if (shareCredits == null || isNaN(shareCredits)) shareCredits = 0

    sharesData.shareCredits += parseInt(shareCredits)
    sharesData.validSubmittedSolutionsCount += 1
    sharesData.lastSubmittedSolutionTime = peerUtils.getUnixTimeNow()

    await this.saveSharesData(minerEthAddress, sharesData)
  },

  async saveSharesData (minerEthAddress, sharesData) {
    if (minerEthAddress == null) return

    minerEthAddress = minerEthAddress.toString().toLowerCase()

    await this.mongoInterface.upsertOne('shares_data_downcase', { minerEthAddress: minerEthAddress }, sharesData)

    // only save to redis for frontend
    await this.redisInterface.storeRedisHashData('shares_data_downcase', minerEthAddress, JSON.stringify(sharesData))
  },

  async getSharesData (minerEthAddress) {
    if (minerEthAddress) {
      minerEthAddress = minerEthAddress.toString().toLowerCase()

      var sharesDataJSON = await this.mongoInterface.findOne('shares_data_downcase', { minerEthAddress: minerEthAddress })

      if (sharesDataJSON) {
        return sharesDataJSON
      }

      // broken
      var defaultShareDataJSON = this.getDefaultSharesData(minerEthAddress)
      return defaultShareDataJSON
    }

    return null
  },

  async saveMinerDataToRedisMongo (minerEthAddress, minerData) {
    if (minerEthAddress == null) return

    minerEthAddress = minerEthAddress.toString().toLowerCase()

    await this.redisInterface.storeRedisHashData('miner_data_downcase', minerEthAddress, JSON.stringify(minerData))

    await this.mongoInterface.upsertOne('miner_data_downcase', { minerEthAddress: minerEthAddress }, minerData)
  },

  async getMinerData (minerEthAddress) {
    if (minerEthAddress) {
      var minerData = await this.mongoInterface.findOne('miner_data_downcase', { minerEthAddress: minerEthAddress.toString().toLowerCase() })

      if (minerData == null) {
        return this.getDefaultMinerData(minerEthAddress)
      }

      return (minerData)
    }

    return null
  },

  getDefaultMinerData (minerEthAddress) {
    if (minerEthAddress == null) minerEthAddress = '0x0' // this should not happen

    return {
      minerEthAddress: minerEthAddress.toString().toLowerCase(),
      // shareCredits: 0,
      tokenBalance: 0, // what the pool owes currenc..deprecated
      alltimeTokenBalance: 0, // total amt pool owes (total amt mined)
      tokensAwarded: 0 // total amt added to balance payments !
    //   varDiff: 1, //default
    //   validSubmittedSolutionsCount: 0
    }
  },

  getDefaultSharesData (minerEthAddress) {
    if (minerEthAddress == null) minerEthAddress = '0x0' // this should not happen

    return {
      minerEthAddress: minerEthAddress.toString().toLowerCase(),
      shareCredits: 0,
      varDiff: 1, // default
      validSubmittedSolutionsCount: 0,
      hashrate: 0
    }
  },

  async getTotalMinerShares () {
    var allMinerData = await this.getAllMinerData()

    var totalShares = 0

    for (var i in allMinerData) {
      var data = allMinerData[i].sharesData
      totalShares += data.shareCredits
    }

    console.log('getTotalMinerShares: got miner total shares', totalShares)
    return totalShares
  },

  async getTotalMinerHashrate () {
    var allMinerData = await this.getAllMinerData()

    var totalHashrate = 0

    for (var i in allMinerData) {
      var data = allMinerData[i].sharesData

      var hashrate = parseInt(data.hashRate)

      if (hashrate) {
        totalHashrate += hashrate
      }
    }

    console.log('getTotalMinerHashrate: got miner total hashrate', totalHashrate)
    return totalHashrate
  },

  async getAllMinerData () {
    var minerList = await this.getMinerList()

    var results = []

    for (const i in minerList) {
      var minerAddress = minerList[i]
      var minerData = await this.getMinerData(minerAddress)
      var sharesData = await this.getSharesData(minerAddress)
      results.push({ minerAddress: minerAddress, minerData: minerData, sharesData: sharesData })
    }

    return results
  },

  async getMinerList () {
    var minerData = await this.redisInterface.getResultsOfKeyInRedis('miner_data_downcase')

    return minerData
  },

  async initJSONRPCServer () {
    var self = this

    console.log('peer-interface:initJSONRPCSever: listening on JSONRPC server localhost:8080')
    // create a server
    var server = jayson.server({
      ping: function (args, callback) {
        callback(null, 'pong')
      },

      getPoolProtocolVersion: function (args, callback) {
        return '1.02'
      },

      getPoolEthAddress: function (args, callback) {
        callback(null, self.getMintHelperAddress().toString())
      },

      getMinimumShareDifficulty: async function (args, callback) {
        /* TODO: Automatic vardiff adjustment is broken. For now, override miner
                 interface to force all miners to poolconfig minimumShareDifficulty  */
        var varDiff = this.poolConfig.minimumShareDifficulty

        // var minerEthAddress = args[0]
        // var varDiff = await self.getMinerVarDiff(minerEthAddress)

        callback(null, varDiff)
      },

      getMinimumShareTarget: async function (args, callback) {
        var minerEthAddress = args[0]

        var varDiff = await self.getMinerVarDiff(minerEthAddress)

        // always described in 'hex' to the cpp miner
        var minTargetBN = self.getPoolMinimumShareTarget(varDiff)

        // console.log('giving target ', minTargetBN , minTargetBN.toString(16) )
        callback(null, minTargetBN.toString())
      },
      getChallengeNumber: async function (args, callback) {
        var challenge_number = await self.redisInterface.loadRedisData('challengeNumber')

        if (challenge_number != null) {
          challenge_number = challenge_number.toString()
        }
        callback(null, challenge_number)
      },

      allowingCustomVardiff: async function (args, callback) {
        return this.poolConfig.allowCustomVardiff
      },

      submitShare: async function (args, callback) {
        var validJSONSubmit = true

        var nonce = args[0]
        var minerEthAddress = args[1]
        var digest = args[2]
        var difficulty = args[3]
        var challenge_number = args[4]
        var custom_vardiff_used = args[5]

        if (
          difficulty == null ||
            nonce == null ||
            minerEthAddress == null ||
            challenge_number == null ||
            digest == null
        ) {
          validJSONSubmit = false
        }

        if (custom_vardiff_used == null) {
          custom_vardiff_used = false
        }

        var minShareDifficulty = self.getPoolMinimumShareDifficulty()
        if (difficulty < minShareDifficulty) {
          validJSONSubmit = false
        }

        var maxShareDifficulty = self.getPoolMaximumShareDifficulty()
        if (maxShareDifficulty != null && difficulty > maxShareDifficulty) {
          difficulty = maxShareDifficulty
        }

        var poolEthAddress = self.getMintHelperAddress()
        var poolChallengeNumber = await self.tokenInterface.getPoolChallengeNumber()
        var computed_digest = web3utils.soliditySha3(poolChallengeNumber, poolEthAddress, nonce)

        var digestBigNumber = web3utils.toBN(digest)
        var claimedTarget = self.getTargetFromDifficulty(difficulty)

        if (computed_digest !== digest || digestBigNumber.gte(claimedTarget)) {
          validJSONSubmit = false
        }

        var ethBlock = await self.redisInterface.getEthBlockNumber()

        var shareData = {
          block: ethBlock,
          nonce: nonce,
          minerEthAddress: minerEthAddress,
          challengeNumber: challenge_number,
          digest: digest,
          difficulty: difficulty,
          customVardiff: custom_vardiff_used
        }

        await self.redisInterface.pushToRedisList('queued_shares_list', JSON.stringify(shareData))

        callback(null, validJSONSubmit)
      },

      getMinerData: async function (args, callback) {
        var minerEthAddress = args[0]
        var minerData = null

        if (web3utils.isAddress(minerEthAddress.toString())) {
          minerData = await self.getMinerData(minerEthAddress)
        } else {
          console.log('getMinerData error: not a valid address')
        }

        var minDiff = self.getPoolMinimumShareDifficulty()

        if (minerData != null && minerData.varDiff < minDiff) {
          minerData.varDiff = minDiff
        }

        callback(null, JSON.stringify(minerData))
      },
      getAllMinerData: async function (args, callback) {
        var minerData = await self.getAllMinerData()

        callback(null, JSON.stringify(minerData))
      }

    })
    server.http().listen(8080)
  },

  async getAllTransactionData () {
    var ethereumTransactionHashes = await this.redisInterface.getResultsOfKeyInRedis('active_transactions')
    var ethereumTransactions = []

    for (const i in ethereumTransactionHashes) {
      var hash = ethereumTransactionHashes[i]

      var packetDataJSON = await this.redisInterface.findHashInRedis('active_transactions', hash)
      var packetData = JSON.parse(packetDataJSON)

      packetData.txHash = hash
      ethereumTransactions.push(packetData)
    }
    return ethereumTransactions
  },

  async getPoolData () {
    return {
      tokenFee: this.poolConfig.poolTokenFee,
      mintingAddress: this.accountConfig.minting.address,
      paymentAddress: this.accountConfig.payment.address
    }
  },

  getMintHelperAddress () {
    if (this.pool_env == 'test') {
      return deployedContractInfo.networks.testnet.contracts.mintforwarder.blockchain_address
    } else if (this.pool_env == 'staging') {
      return deployedContractInfo.networks.staging.contracts.mintforwarder.blockchain_address
    } else {
      return deployedContractInfo.networks.mainnet.contracts.mintforwarder.blockchain_address
    }
  },

  getMintingAccount () {
    return this.accountConfig.minting
  },

  getPaymentAccount () {
    return this.accountConfig.payment
  }
}
