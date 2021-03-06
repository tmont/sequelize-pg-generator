/* tslint:disable */
/* eslint:disable */
// autogenerated by sequelize-pg-generator@0.0.1

import Sequelize = require('sequelize');
import { DataTypes, DefineAttributes, DefineOptions } from 'sequelize';


export interface AuthorAttributes {
	id: number
	name: string
}

export interface Author extends Sequelize.Instance<AuthorAttributes>, AuthorAttributes {

}

export default (
	sequelize: Sequelize.Sequelize,
	tableOptions?: DefineOptions<Author>
): Sequelize.Model<Author, AuthorAttributes> => {
	const DataTypes: DataTypes = sequelize.Sequelize;

	tableOptions = tableOptions || {};
	tableOptions.freezeTableName = true;
	tableOptions.tableName = 'author';

	const columns: DefineAttributes = {
		id: {
			field: 'id',
			type: DataTypes.INTEGER /* integer */,
			primaryKey: true,
			allowNull: false,
			autoIncrement: true
		},
		name: {
			field: 'name',
			type: DataTypes.STRING(255) /* character varying */,
			primaryKey: false,
			allowNull: false,
			autoIncrement: false
		}
	};

	return sequelize.define<Author, AuthorAttributes>(
		'Author',
		columns,
		tableOptions
	);
};
