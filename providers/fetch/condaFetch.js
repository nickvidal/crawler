// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const AbstractFetch = require('./abstractFetch')
const { clone } = require('lodash')
const fs = require('fs')
const memCache = require('memory-cache')
const nodeRequest = require('request')
const FetchResult = require('../../lib/fetchResult')

class CondaFetch extends AbstractFetch {
  constructor(options) {
    super(options)
    this.packageMapFolder = this.options.cdFileLocation
    this.channels = {
      'anaconda-main': 'https://repo.anaconda.com/pkgs/main',
      'anaconda-r': 'https://repo.anaconda.com/pkgs/r',
      'conda-forge': 'https://conda.anaconda.org/conda-forge'
    }
  }

  canHandle(request) {
    const spec = this.toSpec(request)
    return spec && this.channels[spec.provider]
  }

  //      {type: conda|condasrc}/{provider: anaconda-main|anaconda-r|conda-forge}/{architecture|-}/{package name}/[{version | _}]-[{build version | _}]/
  // i.e. conda/conda-forge/linux-aarch64/numpy/1.13.0-py36/
  //      conda/conda-forge/-/numpy/-py36/
  //      conda/conda-forge/-/numpy/1.13.0-py36/
  //      conda/conda-forge/linux-aarch64/numpy/_-py36/
  //      conda/conda-forge/-/numpy/
  //      conda/conda-forge/-/numpy/_-_
  async handle(request) {
    const spec = this.toSpec(request)
    if (!this.channels[spec.provider]) {
      return request.markSkip(`Unrecognized conda provider: ${spec.provider}, must be either of: ${Object.keys(this.channels)}`)
    }
    const channelData = await this.getChannelData(this.channels[spec.provider], spec.provider)
    if (!channelData) {
      return request.markSkip('failed to fetch and parse channelData.json')
    }
    let architecture = spec.namespace
    let [version, buildVersion] = (spec.revision || '').split('-')
    if (channelData.packages[spec.name] === undefined) {
      return request.markSkip(`Missing package ${spec.name} in channel: ${spec.provider}`)
    }
    const packageChannelData = channelData.packages[spec.name]
    if (spec.type !== 'conda' && spec.type !== 'condasrc') {
      return request.markSkip('spec type must either be conda or condasrc')
    }
    // unless otherwise specified, we fetch the architecture package
    if (spec.type === 'conda' && packageChannelData.subdirs.length === 0) {
      return request.markSkip('No architecture build in package channel data')
    }
    if ((!architecture || architecture === '-') && spec.type === 'conda') {
      // prefer no-arch if available
      architecture = packageChannelData.subdirs.includes('noarch') ? 'noarch' : packageChannelData.subdirs[0]
      this.logger.info(`No binary architecture specified for ${spec.name}, using architecture: ${architecture}`)
    }
    if (spec.type === 'condasrc') {
      return this._downloadCondaSourcePackage(spec, request, version, packageChannelData)
    } else {
      return this._downloadCondaPackage(
        spec,
        request,
        version,
        buildVersion,
        architecture,
        packageChannelData
      )
    }
  }

  async _downloadCondaSourcePackage(spec, request, version, packageChannelData) {
    if (version && version !== '_' && packageChannelData.version !== version) {
      return request.markSkip(`Missing source file version ${version} for package ${spec.name}`)
    }
    if (!packageChannelData.source_url) {
      return request.markSkip(`Missing archive source file in repodata for package ${spec.name}`)
    }
    let downloadUrl = new URL(`${packageChannelData.source_url}`).href
    spec.revision = packageChannelData.version
    request.url = spec.toUrl()
    super.handle(request)
    const file = this.createTempFile(request)
    const dir = this.createTempDir(request)
    await this._downloadPackage(downloadUrl, file.name)
    await this.decompress(file.name, dir.name)
    const hashes = await this.computeHashes(file.name)
    const fetchResult = new FetchResult(request.url)
    fetchResult.document = {
      location: dir.name,
      registryData: { 'channelData': packageChannelData, downloadUrl },
      releaseDate: new Date(packageChannelData.timestamp).toUTCString(),
      declaredLicenses: packageChannelData.license,
      hashes
    }
    fetchResult.casedSpec = clone(spec)
    request.fetchResult = fetchResult.adoptCleanup(dir, request)
    return request
  }

  _matchPackage(spec, version, buildVersion, repoData) {
    let packageRepoEntries = []
    let packageMatches = ([, packageData]) => {
      return packageData.name === spec.name && ((!version) || version === '_' || version === packageData.version)
        && ((!buildVersion) || buildVersion === '_' || packageData.build.startsWith(buildVersion))
    }
    if (repoData['packages']) {
      packageRepoEntries = packageRepoEntries.concat(Object.entries(repoData['packages'])
        .filter(packageMatches)
        .map(([packageFile, packageData]) => { return { packageFile, packageData } }))
    }
    if (repoData['packages.conda']) {
      packageRepoEntries = packageRepoEntries.concat(Object.entries(repoData['packages.conda'])
        .filter(packageMatches)
        .map(([packageFile, packageData]) => { return { packageFile, packageData } }))
    }
    packageRepoEntries.sort((a, b) => {
      if (a.packageData.build < b.packageData.build) {
        return 1
      } else if (a.packageData.build === b.packageData.build) {
        return 0
      }
      else {
        return -1
      }
    })
    return packageRepoEntries
  }

  async _downloadCondaPackage(spec, request, version, buildVersion, architecture, packageChannelData) {
    let repoData = undefined
    if (!(packageChannelData.subdirs.find(x => x === architecture))) {
      return request.markSkip(`Missing architecture ${architecture} for package ${spec.name} in channel`)
    }
    repoData = await this.getRepoData(this.channels[spec.provider], spec.provider, architecture)
    if (!repoData) {
      return request.markSkip(`failed to fetch and parse repodata json file for channel ${spec.provider} in architecture ${architecture}`)
    }
    let packageRepoEntries = this._matchPackage(spec, version, buildVersion, repoData)
    if (packageRepoEntries.length == 0) {
      return request.markSkip(`Missing package with matching spec (version: ${version}, buildVersion: ${buildVersion}) in ${architecture} repository`)
    }
    let packageRepoEntry = packageRepoEntries[0]
    let downloadUrl = new URL(`${this.channels[spec.provider]}/${architecture}/${packageRepoEntry.packageFile}`).href
    spec.namespace = architecture
    spec.revision = packageRepoEntry.packageData.version + '-' + packageRepoEntry.packageData.build
    request.url = spec.toUrl()
    super.handle(request)
    const file = this.createTempFile(request)
    const dir = this.createTempDir(request)
    await this._downloadPackage(downloadUrl, file.name)
    await this.decompress(file.name, dir.name)
    const hashes = await this.computeHashes(file.name)
    const fetchResult = new FetchResult(request.url)
    fetchResult.document = {
      location: dir.name,
      registryData: { 'channelData': packageChannelData, 'repoData': packageRepoEntry, downloadUrl },
      releaseDate: new Date(packageRepoEntry.packageData.timestamp).toUTCString(),
      declaredLicenses: packageRepoEntry.packageData.license,
      hashes
    }
    fetchResult.casedSpec = clone(spec)
    request.fetchResult = fetchResult.adoptCleanup(dir, request)
    return request
  }

  async _downloadPackage(downloadUrl, destination) {
    return new Promise(
      (resolve, reject) => {
        const options = {
          url: downloadUrl,
          headers: {
            'User-Agent': 'clearlydefined.io crawler (clearlydefined@outlook.com)'
          }
        }
        nodeRequest.get(options, (error, response) => {
          if (error) {
            return reject(error)
          }
          if (response.statusCode !== 200) {
            return reject(new Error(`${response.statusCode} ${response.statusMessage}`))
          }
        }).pipe(fs.createWriteStream(destination).on('finish', () =>
          resolve()
        ))
      }
    )
  }

  async _cachedDownload(cacheKey, sourceUrl, cacheDuration, fileDstLocation) {
    if (!memCache.get(cacheKey)) {
      return new Promise(
        (resolve, reject) => {
          const options = {
            url: sourceUrl,
            headers: {
              'User-Agent': 'clearlydefined.io crawler (clearlydefined@outlook.com)'
            }
          }
          nodeRequest.get(options, (error, response) => {
            if (error) {
              return reject(error)
            }
            if (response.statusCode !== 200) {
              return reject(new Error(`${response.statusCode} ${response.statusMessage}`))
            }
          }).pipe(fs.createWriteStream(fileDstLocation).on('finish', () => {
            memCache.put(cacheKey, true, cacheDuration)
            this.logger.info(
              `Conda: retrieved ${sourceUrl}. Stored channel data file at ${fileDstLocation}`
            )
            return resolve()
          }))
        }
      )
    }
  }

  async getChannelData(condaChannelUrl, condaChannelID) {
    // ~10MB file, needs to be cached
    let channelDataFile = {
      url: `${condaChannelUrl}/channeldata.json`,
      cacheKey: `${condaChannelID}-channelDataFile`,
      cacheDuration: 8 * 60 * 60 * 1000,// 8 hours
      fileLocation: `${this.packageMapFolder}/${condaChannelID}-channelDataFile.json`
    }
    try {
      await this._cachedDownload(channelDataFile.cacheKey, channelDataFile.url,
        channelDataFile.cacheDuration, channelDataFile.fileLocation)
    } catch (error) {
      return null
    }
    let fileText = fs.readFileSync(channelDataFile.fileLocation)
    return JSON.parse(fileText)
  }

  async getRepoData(condaChannelUrl, condaChannelID, architecture) {
    // ~30MB file, needs to be cached
    let repoFile = {
      url: `${condaChannelUrl}/${architecture}/repodata.json`,
      cacheKey: `${condaChannelID}-repoDataFile-${architecture}`,
      cacheDuration: 8 * 60 * 60 * 1000,// 8 hours
      fileLocation: `${this.packageMapFolder}/${condaChannelID}-repoDataFile-${architecture}.json`
    }
    try {
      await this._cachedDownload(repoFile.cacheKey, repoFile.url,
        repoFile.cacheDuration, repoFile.fileLocation)
    } catch (error) {
      return null
    }
    let fileText = fs.readFileSync(repoFile.fileLocation)
    return JSON.parse(fileText)
  }
}

module.exports = options => new CondaFetch(options)
