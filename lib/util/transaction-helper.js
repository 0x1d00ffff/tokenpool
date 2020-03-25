
const ContractHelper = require('./contract-helper.js')
const ConfigHelper = require('./config-helper.js')

var web3utils = require('web3-utils')

const Tx = require('ethereumjs-tx')

const poolConfig = require('../../pool.config').config

module.exports = {

  init (web3, pool_env, redisInterface, mongoInterface) {
    this.pool_env = pool_env
    this.web3 = web3

    console.log('pool ENV ', pool_env)

    this.mongoInterface = mongoInterface
    this.redisInterface = redisInterface
    this.accountConfig = ConfigHelper.getAccountConfig(this.pool_env)

    this.tokenContract = ContractHelper.getTokenContract(this.web3, this.pool_env)
    // this.miningKingContract = ContractHelper.getMiningKingContract(this.web3,this.pool_env)
    this.mintHelperContract = ContractHelper.getMintHelperContract(this.web3, this.pool_env)
    this.paymentContract = ContractHelper.getPaymentContract(this.web3, this.pool_env)
    // this.doubleKingsRewardContract = ContractHelper.getDoubleKingsRewardContract(this.web3,this.pool_env)
  },

  async submitMiningSolutionTwo (minerAddress, solution_number, challenge_digest, challenge_number) {
    var addressFrom = this.getMintingAccount().address

    console.log('\n')
    console.log('submitMiningSolutionTwo: ---Submitting solution for reward using mining forwarder---')
    console.log('submitMiningSolutionTwo: nonce ', solution_number)
    console.log('submitMiningSolutionTwo: challenge_number ', challenge_number)
    console.log('submitMiningSolutionTwo: challenge_digest ', challenge_digest)
    console.log('\n')

    var mintMethod = this.mintHelperContract.methods.proxyMint(solution_number, challenge_digest)

    try {
      var txCount = await this.web3.eth.getTransactionCount(addressFrom)
      console.log('submitMiningSolutionTwo: txCount', txCount)
    } catch (error) { // here goes if someAsyncPromise() rejected}
      console.log('submitMiningSolutionTwo: error', error)

      return error // this will result in a resolved promise.
    }

    var addressTo = this.mintHelperContract.options.address

    var txData = this.web3.eth.abi.encodeFunctionCall({
      name: 'proxyMint',
      type: 'function',
      inputs: [{
        type: 'uint256',
        name: 'nonce'
      }, {
        type: 'bytes32',
        name: 'challenge_digest'
      }]
    }, [solution_number, challenge_digest])

    var max_gas_cost = 1704624 * 2 // 1704624

    // having an issue ?
    var estimatedGasCost = await mintMethod.estimateGas({ gas: max_gas_cost, from: addressFrom, to: addressTo })

    console.log('submitMiningSolutionTwo: estimatedGasCost', estimatedGasCost)
    console.log('submitMiningSolutionTwo: txData', txData)

    console.log('submitMiningSolutionTwo: addressFrom', addressFrom)
    console.log('submitMiningSolutionTwo: addressTo', addressTo)

    if (estimatedGasCost > max_gas_cost) {
      console.log('submitMiningSolutionTwo: Gas estimate too high!  Something went wrong ')
      return
    }

    const txOptions = {
      nonce: web3utils.toHex(txCount),
      gas: web3utils.toHex(estimatedGasCost * 2),
      gasPrice: web3utils.toHex(web3utils.toWei(poolConfig.solutionGasPriceWei.toString(), 'gwei')),
      value: 0,
      to: addressTo,
      from: addressFrom,
      data: txData
    }

    var privateKey = this.getMintingAccount().privateKey

    return new Promise(function (result, error) {
      this.sendSignedRawTransaction(this.web3, txOptions, addressFrom, privateKey, function (err, res) {
        if (err) {
          console.log('submitMiningSolutionTwo: error', err)
          error(err)
        }
        console.log('submitMiningSolutionTwo: got tx result', res)
        result(res)
      })
    }.bind(this))
  },

  async transferPaymentBatch (batchPayment) {
    console.log('transferPaymentBatch: broadcasting batch payment', batchPayment)
    var self = this

    // update the batch payment entry in mongo to mark when it was last broadcasted
    // TODO: shouldn't we do this after re-broadcasting is complete/successful?
    var currentEthBlock = await self.redisInterface.getEthBlockNumber()
    batchPayment.broadcastedAt = currentEthBlock
    await self.mongoInterface.upsertOne('payment_batch', { id: batchPayment.id }, batchPayment)

    // do the broadcast here
    var addressTo = this.paymentContract.options.address

    // by default, transfer from payout address
    var privateKey = this.getPaymentAccount().privateKey
    var addressFrom = this.getPaymentAccount().address

    var tokenAddress = this.tokenContract.options.address
    var toAddressArray = []
    var toValueArray = []

    var paymentsInBatch = await self.mongoInterface.findAll('balance_payment', { batchId: batchPayment.id })

    if (paymentsInBatch.length <= 0) {
      console.log('transferPaymentBatch: no proposed payments in this batch; not transferring')
      return
    }

    for (var payment of paymentsInBatch) {
      try {
        var checksumAddress = web3utils.toChecksumAddress(payment.minerAddress)
      } catch (err) {
        console.log('transferPaymentBatch: invalid toAddress:', payment.minerAddress)
        continue
      }
      toAddressArray.push(checksumAddress)
      toValueArray.push(Math.floor(payment.amountToPay)) // get in satoastis ?
    }
    if (toValueArray.length == 0) {
      console.log('transferPaymentBatch: no valid payments in this batch; not transferring')
      return
    }

    try {
      var txCount = await this.web3.eth.getTransactionCount(addressFrom)
      console.log('transferPaymentBatch: txCount', txCount)
    } catch (error) { // here goes if someAsyncPromise() rejected}
      console.log('transferPaymentBatch: txCount error', error)

      return error // this will result in a resolved promise.
    }

    console.log('transferPaymentBatch: from to ', addressFrom, addressTo)
    console.log('transferPaymentBatch: (tokenAddress, batchPayment.id, toAddressArray, toValueArray', [tokenAddress, batchPayment.id, toAddressArray, toValueArray])

    var txData = this.web3.eth.abi.encodeFunctionCall({
      name: 'multisend',
      type: 'function',
      inputs: [
        {
          name: '_tokenAddr',
          type: 'address'
        },
        {
          name: 'paymentId',
          type: 'bytes32'
        },
        {
          name: 'dests',
          type: 'address[]'
        },
        {
          name: 'values',
          type: 'uint256[]'
        }
      ]
    }, [tokenAddress, batchPayment.id, toAddressArray, toValueArray])

    var max_gas_cost = 1700463

    try {
      console.log('transferPaymentBatch: estimate gas')
      var transferMethod = this.paymentContract.methods.multisend(tokenAddress, batchPayment.id, toAddressArray, toValueArray)
      var estimatedGasCost = await transferMethod.estimateGas({ gas: max_gas_cost, from: addressFrom, to: addressTo })
      if (estimatedGasCost > max_gas_cost) {
        console.log('transferPaymentBatch: Gas estimate too high! Something went wrong. estimatedGasCost=', estimatedGasCost)
        return
      } else {
        console.log('transferPaymentBatch: estimated gas ', estimatedGasCost)
      }
    } catch (e) {
      console.error('transferPaymentBatch: estimateGas threw an exception', e)
      return { success: false, paymentsInBatch: paymentsInBatch, txHash: null }
    }

    const txOptions = {
      nonce: web3utils.toHex(txCount),
      gas: web3utils.toHex(estimatedGasCost),
      gasPrice: web3utils.toHex(web3utils.toWei(poolConfig.transferGasPriceWei.toString(), 'gwei')),
      value: 0,
      to: addressTo,
      from: addressFrom,
      data: txData
    }

    try {
      var txHash = await new Promise(function (result, error) {
        this.sendSignedRawTransaction(this.web3, txOptions, addressFrom, privateKey, function (err, res) {
          if (err) {
            console.log('transferPaymentBatch: sendSignedRawTransaction error', err)
            error(err)
          }
          console.log('transferPaymentBatch: sendSignedRawTransaction got tx result', res)
          result(res)
        })
      }.bind(this))
    } catch (err) {
      console.error('transferPaymentBatch: sendSignedRawTransaction raised exception', err)
      throw err
    }

    if (txHash) // not guaranteed, only for rendering-- NOT for logic
    {
      batchPayment.txHash = txHash
      await self.mongoInterface.upsertOne('payment_batch', { id: batchPayment.id }, batchPayment)
    }

    return { success: true, paymentsInBatch: paymentsInBatch, txHash: txHash }
  },

  async broadcastPaymentBatches () {
    var self = this

    // if we have a pending broadcasting batch just continue..
    // IMPLEMENT ^

    var broadcastedPayment = null

    try {
      var currentEthBlock = await self.redisInterface.getEthBlockNumber()

      var REBROADCAST_WAIT_BLOCKS = Math.min(10, poolConfig.rebroadcastPaymentWaitBlocks)

      var unconfirmedBatches = await self.mongoInterface.findAll('payment_batch', { confirmed: false })

      for (var element of unconfirmedBatches) {
        // console.log('broadcastPaymentBatches: checking batch for transfer - ', element.id, element.broadcastedAt , currentEthBlock )
        console.log('broadcastPaymentBatches:', element.id, 'checking if transferred...')
        /// if it has not been recently broadcasted
        if (element.broadcastedAt == null || element.broadcastedAt < (currentEthBlock - REBROADCAST_WAIT_BLOCKS)) {
          if (element.broadcastedAt == null) {
            console.log('broadcastPaymentBatches:', element.id, 'broadcastedAt null')
          } else {
            console.log('broadcastPaymentBatches:', element.id, 'broadcasted', currentEthBlock - element.broadcastedAt, 'blocks ago')
          }

          var complete = await self.paymentContract.methods.paymentSuccessful(element.id).call()

          // if it REALLY has never been completed before  (double check)
          if (!complete) {
            console.log('broadcastPaymentBatches:', element.id, 'incomplete; transferring')
            broadcastedPayment = await this.transferPaymentBatch(element)
            break // we will broadcast just this one and that is all
          }
        }
      }
    } catch (e) {
      console.log('broadcastPaymentBatches: error', e)
    }
    return broadcastedPayment
  },

  /*
    Walk through all payment batches. If any are confirmed, mark them complete
    TODO: this function should run on an eth block delay to avoid reorgs
  */
  async checkBatchPaymentsStatus () {
    console.log('checkBatchPaymentsStatus: start')
    var self = this

    var unconfirmedBatches = await self.mongoInterface.findAll('payment_batch', { confirmed: false })
    // this type of for loop works with async & .forEach does not
    for (var element of unconfirmedBatches) {
      var complete = await self.paymentContract.methods.paymentSuccessful(element.id).call()
      // console.log('checkBatchPaymentsStatus: complete??', complete)

      if (complete) {
        element.confirmed = true
        await self.markPaymentsCompleteForBatch(element)
        await self.mongoInterface.upsertOne('payment_batch', { id: element.id }, element)
      }
    }
    // console.log('checkBatchPaymentsStatus: done w for each ')
    return true
  },

  async markPaymentsCompleteForBatch (batchPayment) {
    var self = this
    // await self.mongoInterface.upsertOne('balance_payment',{id: element.id},  element  )
    // var paymentsForBatch =   await self.mongoInterface.findAll('balance_payment',{batchId: false}   )
    var paymentsForBatch = await self.mongoInterface.findAll('balance_payment', { batchId: batchPayment.id })

    for (var element of paymentsForBatch) {
      element.txHash = batchPayment.txHash
      element.confirmed = batchPayment.confirmed
      element.broadcastedAt = batchPayment.broadcastedAt

      await self.mongoInterface.upsertOne('balance_payment', { id: element.id }, element)
    }
    return true
  },

  // This is throwing up an error !
  async requestCurrentChallengeNumber () {
    var self = this
    var result = new Promise(function (fulfilled, error) {
      self.tokenContract.methods.getChallengeNumber().call(function (err, result) {
        if (err) {
          console.log('requestCurrentChallengeNumber: error', err)
          error(err)
          return
        }

        fulfilled(result)
      })
    })

    console.log('requestCurrentChallengeNumber:', result)
    return result
  },

  async sendSignedRawTransaction (web3, txOptions, addressFrom, private_key, callback) {
    var privKey = this.truncate0xFromString(private_key)

    const privateKey = new Buffer(privKey, 'hex')
    const transaction = new Tx(txOptions)

    transaction.sign(privateKey)

    const serializedTx = transaction.serialize().toString('hex')

    try {
      web3.eth.sendSignedTransaction('0x' + serializedTx, callback)
    } catch (e) {
      console.log('sendSignedRawTransaction: error', e)
    }
  },

  truncate0xFromString (s) {
    if (s.startsWith('0x')) {
      return s.substring(2)
    }
    return s
  },

  getMintingAccount () {
    return this.accountConfig.minting
  },

  getPaymentAccount () {
    return this.accountConfig.payment
  }

}
