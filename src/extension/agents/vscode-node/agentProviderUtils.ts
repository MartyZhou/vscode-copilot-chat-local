/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';

interface WriteCachedAgentFileOptions {
	readonly cacheDir: string;
	readonly fileName: string;
	readonly content: string;
	readonly providerName: string;
	readonly extensionContext: IVSCodeExtensionContext;
	readonly fileSystemService: IFileSystemService;
	readonly logService: ILogService;
}

export async function writeCachedAgentFile(options: WriteCachedAgentFileOptions): Promise<vscode.Uri> {
	const cacheDir = vscode.Uri.joinPath(options.extensionContext.globalStorageUri, options.cacheDir);

	try {
		await options.fileSystemService.stat(cacheDir);
	} catch {
		await options.fileSystemService.createDirectory(cacheDir);
	}

	const fileUri = vscode.Uri.joinPath(cacheDir, options.fileName);
	await options.fileSystemService.writeFile(fileUri, new TextEncoder().encode(options.content));
	options.logService.trace(`[${options.providerName}] Wrote agent file: ${fileUri.toString()}`);
	return fileUri;
}
