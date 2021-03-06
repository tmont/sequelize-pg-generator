#!/usr/bin/env node

const start = Date.now();
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const { Client } = require('pg');
const pkg = require('./package.json');
const inflection = require('inflection');

const pkgVersion = pkg.version;
const pkgName = pkg.name;
const preamble = `/* tslint:disable */
/* eslint:disable */
// autogenerated by ${pkgName}@${pkgVersion}`;

const parseArgs = (args) => {
	const program = {
		quiet: false,
		connection: {}
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '--version':
				process.stdout.write(pkgVersion);
				process.exit(0);
				return;
			case '--help':
				usage(0);
				return;
			case '--models-dir':
				program.modelsDir = args[++i];
				break;
			case '--verbose':
			case '-v':
				program.verbose = 1;
				break;
			case '-vv':
				program.verbose = 2;
				break;
			case '--quiet':
			case '-q':
				program.quiet = true;
				break;
			case '--relations-file':
				program.relationsFile = args[++i];
				break;
			case '--indent':
				program.indent = args[++i];
				break;
			case '--typescript':
				program.typescript = true;
				break;
			case '--include-foreign-keys':
				program.includeForeignKeys = true;
				break;
			case '--camel-case':
				program.camelCase = true;
				break;

			// pg options
			case '-U':
			case '--username':
				program.connection.user = args[++i];
				break;
			case '-d':
			case '--dbname':
				program.connection.database = args[++i];
				break;
			case '--password':
			case '-p':
				program.connection.password = args[++i];
				break;
			case '--port':
			case '-P':
				program.connection.port = Number(args[++i]);
				break;
			case '--host':
			case '-h':
				program.connection.host = args[++i];
				break;
			case '--schema':
				program.connection.schema = args[++i];
				break;
		}
	}

	return program;
};

const usage = (exitCode) => {
	process.stdout.write(`${pkgName} v${pkgVersion}
  Generates Sequelize models/relations/associations for a postgres database

USAGE
  ${pkgName} --host hostname --username username --dbname dbname --models-dir dir
    --relations-file file [--port port] [--password password] [--schema schema] 
    [--verbose] [--typescript] [--help] [--version] [--include-foreign-keys]

OPTIONS
  Postgres connection options:
    --dbname|-d dbname       The name of the database
    --host|-h hostname       The hostname of the database
    --password|-p password   The PostgreSQL password
    --port|-P port           The port the PostgreSQL server runs on
    --schema schema          The schema to model (public)
    --username|-U username   The username to connect to PostgreSQL
    
  Output options:
    --models-dir dir         Output generated models in this directory
    --relations-file file    Output relations to this file
    --typescript             Generate TypeScript instead of JavaScript
    --indent str             String to use for indentation (TAB)
    --include-foreign-keys   Include foreign key ID fields in table attributes
    --camel-case             Convert field names to camel case
  
  Other options:
    --help                   Show this help message
    --verbose|-v|-vv         Output debugging messages to stderr
    --version                Show the version of this program
`
	);


	process.exit(exitCode || 0);
};

const log = (msg, force) => {
	if (force || (program.verbose && !program.quiet)) {
		process.stderr.write(msg + '\n');
	}
};

const program = parseArgs(process.argv);
const connection = program.connection;
const targetDir = program.modelsDir ? path.resolve(program.modelsDir) : null;
let targetAssociationsFile = program.relationsFile ? path.resolve(program.relationsFile) : null;
if (!/\..+/.test(targetAssociationsFile)) {
	if (program.typescript) {
		targetAssociationsFile += '.ts';
	} else {
		targetAssociationsFile += '.js';
	}
}

const logTab = num => '  '.repeat(num);
const indent = program.indent || '\t';
const tab = num => indent.repeat(num);

if (!connection.host) {
	log('host is required', true);
	process.exit(1);
}
if (!connection.database) {
	log('database is required', true);
	process.exit(1);
}
if (!program.modelsDir) {
	log('models directory is required', true);
	process.exit(1);
}
if (!program.relationsFile) {
	log('relations file is required', true);
	process.exit(1);
}

try {
	fs.accessSync(targetDir);
} catch (e) {
	log(`directory "${targetDir}" does not exist`, true);
	process.exit(1);
}
try {
	fs.accessSync(path.dirname(targetAssociationsFile));
} catch (e) {
	log(`"${targetAssociationsFile}" has no parent directory`, true);
	process.exit(1);
}

connection.host = connection.host || 'localhost';
connection.schema = connection.schema || 'public';

const toCamelCase = (value) => {
	return value.replace(/_([a-zA-Z])/g, (_, c) => c.toUpperCase());
};

const toPascalCase = (value) => {
	const camelCase = toCamelCase(value);
	return camelCase.charAt(0).toUpperCase() + camelCase.substring(1);
};

const generate = async () => {
	const dbName = connection.database;
	const schemaName = connection.schema;

	const dsn = `${connection.user}@${connection.host}` +
		`${connection.port ? `:${connection.port}` : ''}` +
		`/${connection.database}`;
	log(`connecting to postgres using ${dsn}`);
	const client = new Client(connection);
	await client.connect();
	log(`successfully connected to postgres`);

	const associations = {};

	const runQuery = async (queryText, params) => {
		if (program.verbose > 1) {
			log(`${queryText} :: [ ${params.join(', ')} ]`);
		}
		const result = await client.query(queryText, params);
		return result.rows;
	};

	const generateDefinitions = async () => {
		const allTablesQuery = `
SELECT 
	table_name 
FROM information_schema.tables
WHERE table_catalog=$1
AND table_schema=$2
ORDER BY table_name`;

		log(`${logTab(1)}fetching tables`);
		const rows = await runQuery(allTablesQuery, [ dbName, schemaName ]);
		log(`${logTab(1)}found ${rows.length} tables`);
		const tables = rows.map(obj => obj.table_name);

		const columnQuery = `
SELECT
	c.column_name,
	c.ordinal_position,
	c.column_default,
	c.is_nullable,
	c.data_type,
	c.character_maximum_length,
	c.numeric_precision,
	c.udt_name::regtype AS udt_name,
	ARRAY_AGG(DISTINCT e.enumlabel)                 AS enum_values,
	ARRAY_AGG(DISTINCT tc.constraint_type::VARCHAR) AS keys
FROM information_schema.columns c
LEFT OUTER JOIN information_schema.key_column_usage k
	ON k.table_catalog = c.table_catalog
	AND k.table_schema = c.table_schema
	AND k.table_name = c.table_name
	AND k.column_name = c.column_name
LEFT OUTER JOIN information_schema.table_constraints tc
	ON tc.table_catalog = k.table_catalog
	AND tc.table_schema = k.table_schema
	AND tc.table_name = k.table_name
	AND tc.constraint_name = k.constraint_name
LEFT OUTER JOIN pg_type t
	ON t.typname = c.udt_name
	AND c.data_type = 'USER-DEFINED'
LEFT OUTER JOIN pg_enum e
	ON e.enumtypid = t.oid
LEFT OUTER JOIN pg_namespace n
	ON n.oid = t.typnamespace
	AND n.nspname = c.table_schema
WHERE c.table_catalog = $1
AND c.table_schema = $2
AND c.table_name = $3
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
ORDER BY c.ordinal_position`;

		const getColumnType = (row) => {
			const data = {
				dataType: null,
				docType: null,
				comment: null,
				tsType: null,
			};
			switch (row.data_type) {
				case 'integer':
				case 'smallint':
					data.dataType = 'INTEGER';
					data.docType = 'number';
					data.tsType = 'number';
					break;
				case 'numeric':
					data.dataType = 'DOUBLE';
					data.docType = 'number';
					data.tsType = 'number';
					break;
				case 'character varying':
					data.dataType = `STRING(${row.character_maximum_length || 'null'})`;
					data.docType = 'string';
					data.tsType = 'string';
					break;
				case 'character':
					data.dataType = `CHAR(${row.character_maximum_length || 'null'})`;
					data.docType = 'string';
					data.tsType = 'string';
					break;
				case 'date':
					data.dataType = 'DATEONLY';
					data.docType = 'Date';
					data.tsType = 'Date';
					break;
				case 'timestamp with time zone':
					data.dataType = 'DATE';
					data.docType = 'Date';
					data.tsType = 'Date';
					break;
				case 'jsonb':
					data.dataType = 'JSONB';
					data.docType = 'Object';
					data.tsType = 'any';
					break;
				case 'json':
					data.dataType = 'JSON';
					data.docType = 'Object';
					data.tsType = 'any';
					break;
				case 'boolean':
					data.dataType = 'BOOLEAN';
					data.docType = 'boolean';
					data.tsType = 'boolean';
					break;
				case 'USER-DEFINED':
					const values = row.enum_values.substring(1, row.enum_values.length - 1).split(',');
					data.dataType = `ENUM('${values.join('\', \'')}')`;
					data.comment = `user defined type: ${row.udt_name}`;
					data.docType = 'string';
					data.tsType = 'string';
					break;
				case 'text':
					data.dataType = `TEXT`;
					data.docType = 'string';
					data.tsType = 'string';
					break;
				case 'ARRAY':
					const innerArrayType = getColumnType({data_type: row.udt_name.replace(/\[]$/, '')});
					data.dataType = `ARRAY(DataTypes.${innerArrayType.dataType})`;
					data.docType = 'Array';
					data.comment = row.udt_name;
					data.tsType = `${innerArrayType.tsType}[]`;
					break;
				default:
					throw new Error(`Unhandled data type: ${row.data_type}`);
			}

			return data;
		};

		const generateTableDefinition = async (tableName) => {
			log(`${logTab(2)}starting generation for ${tableName}`);
			const rows = await runQuery(columnQuery, [ dbName, schemaName, tableName ]);
			log(`${logTab(3)}found ${rows.length} columns for ${tableName}`);
			const propDocs = [];
			const columnData = [];

			const columnsCode = rows
				.map((row) => {
					if (!program.includeForeignKeys) {
						const isForeignKey = row.keys.indexOf('FOREIGN KEY') !== -1;

						if (isForeignKey) {
							return null;
						}
					}

					const propDoc = {};
					const dataTypeData = getColumnType(row);
					const dataType = dataTypeData.dataType;
					const dataTypeComment = dataTypeData.comment || row.data_type;
					propDoc.type = dataTypeData.docType;

					const allowNull = row.is_nullable === 'YES';

					const isPrimaryKey = row.keys.indexOf('PRIMARY KEY') !== -1;
					let defaultValue = null;
					let isAutoIncrement = false;
					let match;

					if (match = /^'(.*)'(?:::character varying)?$/.exec(row.column_default)) {
						defaultValue = JSON.stringify(match[1]);
					} else if (match = /'(.+)'::jsonb$/.exec(row.column_default)) {
						defaultValue = match[1];
					} else if (row.column_default === 'now()') {
						defaultValue = 'DataTypes.NOW';
					} else if (/^nextval\(/.test(row.column_default)) {
						isAutoIncrement = true;
					} else if (row.column_default && dataType === 'BOOLEAN') {
						defaultValue = row.column_default !== 'false';
					} else if (row.column_default && dataType === 'INTEGER') {
						defaultValue = parseInt(row.column_default);
					} else if (row.column_default && row.data_type === 'ARRAY') {
						defaultValue = '[]'; //meh, just default to empty array
					} else if (row.data_type === 'USER-DEFINED' && (match = new RegExp(`'(.+)'::${row.udt_name}$`).exec(row.column_default))) {
						defaultValue = JSON.stringify(match[1]);
					}

					const columnName = program.camelCase ? toCamelCase(row.column_name) : row.column_name;
					const fieldName = row.column_name;

					propDoc.name = columnName;
					propDocs.push(propDoc);

					const lines = [
						`field: '${fieldName}'`,
						`type: DataTypes.${dataType} /* ${dataTypeComment} */`,
						`primaryKey: ${isPrimaryKey}`,
						`allowNull: ${allowNull}`,
						`autoIncrement: ${isAutoIncrement}`,
					];

					if (defaultValue !== null) {
						lines.push(`defaultValue: ${defaultValue}`);
					}

					columnData.push({
						name: columnName,
						field: fieldName,
						typeData: dataTypeData,
						typeComment: dataTypeComment,
						isPrimaryKey: isPrimaryKey,
						allowNull: allowNull,
						autoIncrement: isAutoIncrement,
						defaultValue: defaultValue,
					});

					log(`${logTab(4)}${fieldName} (default=${defaultValue}, type: ${dataType}, nullable: ${allowNull})`);

					return `${tab(2)}${columnName}: {\n` +
						lines.map(line => `${tab(3)}${line}`).join(`,\n`) +
						`\n${tab(2)}}`;
				})
				.filter(Boolean)
				.join(',\n');

			const className = inflection.singularize(toPascalCase(tableName));

			let code = `${preamble}

module.exports = (/** Sequelize */sequelize, tableOptions) => {
${tab(1)}const DataTypes = sequelize.Sequelize.DataTypes;

${tab(1)}tableOptions = tableOptions || {};
${tab(1)}tableOptions.freezeTableName = true;
${tab(1)}tableOptions.tableName = '${tableName}';

${tab(1)}/**
${tab(1)} * @name ${className}
${tab(1)} * @type {{ ${propDocs.map(d => `${d.name}: ${d.type}`).join(', ')} }}
${tab(1)} */
${tab(1)}const columns = {
${columnsCode}
${tab(1)}};

${tab(1)}return sequelize.define('${className}', columns, tableOptions);
};
`;
			if (program.typescript) {
				const attributeCode = columnData
					.map((col) => {
						return `${tab(1)}${col.name}: ${col.typeData.tsType}`;
					})
					.join('\n');

				let instanceCode = '';
				let includeCode = '';
				const sequelizeImports = [ 'DataTypes', 'DefineAttributes', 'DefineOptions' ];

				if (associations[tableName]) {
					if (associations[tableName].some(ass => ass.manyToMany)) {
						sequelizeImports.push('FindOptions');
					}
					const instancedModels = {};
					instanceCode = associations[tableName]
						.map((ass) => {
							if (instancedModels[ass.model]) {
								return '';
							}
							instancedModels[ass.model] = 1;
							if (ass.manyToMany) {
								const pluralized = `${inflection.pluralize(ass.model)}`;
								const pluralLower = pluralized[0].toLowerCase() + pluralized.substring(1);
								const singular = inflection.singularize(ass.model);
								const singularLower = singular[0].toLowerCase() + singular.substring(1);
								return [
									`${tab(1)}get${pluralized}: (options?: FindOptions<${ass.model}>) => Promise<${ass.model}[]>`,
									`${tab(1)}set${pluralized}: (${pluralLower}: ${ass.model}[]) => Promise<void>`,
									`${tab(1)}add${singular}: (${singularLower}: ${ass.model}) => Promise<void>`,
									`${tab(1)}add${pluralized}: (${pluralLower}: ${ass.model}[]) => Promise<void>`,
								]
							}

							const property = ass.model[0].toLowerCase() + ass.model.substring(1);
							return `${tab(1)}${property}: ${ass.model} | null`;
						})
						.filter(Boolean)
						.reduce((lines, next) => {
							return lines.concat(Array.isArray(next) ? next : [ next ]);
						}, [])
						.join('\n');

					const includedModels = {};
					includeCode = associations[tableName]
						.map((ass) => {
							if (includedModels[ass.model]) {
								return '';
							}

							includedModels[ass.model] = 1;
							if (ass.manyToMany) {
								return `import { ${ass.model} } from './${ass.fileName}';`;
							}

							return `import { ${ass.model} } from './${ass.fileName}';`;
						})
						.filter(Boolean)
						.join('\n');
				}

				const attributesClassName = `${className}Attributes`;

				code = `${preamble}

import Sequelize = require('sequelize');
import { ${sequelizeImports.join(', ')} } from 'sequelize';
${includeCode}

export interface ${attributesClassName} {
${attributeCode}
}

export interface ${className} extends Sequelize.Instance<${attributesClassName}>, ${attributesClassName} {
${instanceCode}
}

export default (
${tab(1)}sequelize: Sequelize.Sequelize,
${tab(1)}tableOptions?: DefineOptions<${className}>
): Sequelize.Model<${className}, ${attributesClassName}> => {
${tab(1)}const DataTypes: DataTypes = sequelize.Sequelize;

${tab(1)}tableOptions = tableOptions || {};
${tab(1)}tableOptions.freezeTableName = true;
${tab(1)}tableOptions.tableName = '${tableName}';

${tab(1)}const columns: DefineAttributes = {
${columnsCode}
${tab(1)}};

${tab(1)}return sequelize.define<${className}, ${attributesClassName}>(
${tab(2)}'${className}',
${tab(2)}columns,
${tab(2)}tableOptions
${tab(1)});
};
`;
			}

			const ext = program.typescript ? 'ts' : 'js';
			const targetFile = path.join(targetDir, `${tableName}.${ext}`);
			log(`${logTab(3)}writing definition to ${targetFile}`);
			await promisify(fs.writeFile)(targetFile, code, { encoding: 'utf8' });
		};

		for (let i = 0; i < tables.length; i++) {
			await generateTableDefinition(tables[i]);
		}
	};

	const generateAssociations = async () => {
		const foreignKeyQuery = `
WITH fkeys AS (
	SELECT
		tc.constraint_name,
		tc.table_name,
		kcu.column_name,
		ccu.table_name     AS reference_table,
		ccu.column_name    AS reference_column,
		pk.constraint_name AS pri_key
	FROM information_schema.table_constraints tc
	INNER JOIN information_schema.constraint_column_usage ccu
		ON ccu.constraint_name = tc.constraint_name
	INNER JOIN information_schema.key_column_usage kcu
		ON kcu.constraint_name = tc.constraint_name
	LEFT OUTER JOIN (
		SELECT
			tc2.constraint_name,
			tc2.table_name,
			tc2.constraint_type,
			kcu2.column_name
		FROM information_schema.table_constraints tc2
		INNER JOIN information_schema.key_column_usage kcu2
			ON kcu2.constraint_name = tc2.constraint_name
		WHERE tc2.constraint_type = 'PRIMARY KEY'
	) pk
		ON pk.column_name = kcu.column_name
		AND pk.table_name = tc.table_name
	WHERE tc.constraint_type = 'FOREIGN KEY'
	AND tc.constraint_catalog = $1
	AND tc.constraint_schema = $2
	ORDER BY tc.table_name, kcu.column_name, reference_table, reference_column
)
SELECT
	fkeys.*,
	j.reference_table AS other_table
FROM fkeys
LEFT OUTER JOIN fkeys AS j
	ON j.pri_key = fkeys.pri_key
	AND j.constraint_name != fkeys.constraint_name`;

		log(`${logTab(1)}fetching foreign keys`);
		const rows = await runQuery(foreignKeyQuery, [ dbName, schemaName ]);
		log(`${logTab(1)}found ${rows.length} foreign keys`);

		const relationCode = rows.map((row) => {
			const tableName = row.table_name;
			const columnName = row.column_name;
			const refTableName = row.reference_table;
			const refColumnName = row.reference_column;
			const constraintName = row.constraint_name;
			const otherTableName = row.other_table;

			const modelName = toPascalCase(tableName);
			const targetModelName = toPascalCase(refTableName);
			const asName = toCamelCase(refTableName);

			const comment = `${tableName}.${columnName} -> ${refTableName}.${refColumnName} (${constraintName})`;
			log(`${logTab(3)}${comment}`);
			let code = `\n${tab(1)}// ${comment}`;

			if (otherTableName) {
				const otherModel = toPascalCase(otherTableName);
				code += `\n${tab(1)}models.${targetModelName}.belongsToMany(models.${otherModel}, { through: models.${modelName}, foreignKey: '${columnName}' });`;
			} else {
				code += `\n${tab(1)}models.${modelName}.belongsTo(models.${targetModelName}, { foreignKey: '${columnName}', as: '${asName}' });`;
			}

			if (otherTableName) {
				if (!associations[otherTableName]) {
					associations[otherTableName] = [];
				}
				if (!associations[refTableName]) {
					associations[refTableName] = [];
				}

				associations[otherTableName].push({
					manyToMany: true,
					model: targetModelName,
					fileName: refTableName
				});
				associations[refTableName].push({
					manyToMany: true,
					model: toPascalCase(otherTableName),
					fileName: otherTableName
				});
			} else {
				if (!associations[tableName]) {
					associations[tableName] = [];
				}

				associations[tableName].push({
					model: targetModelName,
					fileName: refTableName
				});
			}

			return code;
		});

		let code = `${preamble}

module.exports = (sequelize) => {
${tab(1)}const models = sequelize.models;
${tab(1)}${relationCode.join('\n')}
};
`;

		if (program.typescript) {
			code = `${preamble}

import Sequelize = require('sequelize');

export default (sequelize: Sequelize.Sequelize): void => {
${tab(1)}const models = sequelize.models;
${tab(1)}${relationCode.join('\n')}
};
`;
		}


		log(`${logTab(2)}writing associations to ${targetAssociationsFile}`);
		await promisify(fs.writeFile)(targetAssociationsFile, code, {encoding: 'utf8'});
	};

	log('starting association generation');
	await generateAssociations();
	log('starting definition generation');
	await generateDefinitions();
};

generate()
	.then(() => {
		if (!program.quiet) {
			log(`success in ${Date.now() - start}ms`, true);
		}
		process.exit(0);
	})
	.catch((err) => {
		if (!program.quiet) {
			log(`failure in ${Date.now() - start}ms`, true);
		}
		log(`Failed to generate: ${err.message}`, true);
		process.exit(1);
	});
