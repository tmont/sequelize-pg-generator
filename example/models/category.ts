/* tslint:disable */
/* eslint:disable */
// autogenerated by sequelize-pg-generator@0.0.1

import Sequelize = require('sequelize');
import { DataTypes, DefineAttributes, DefineOptions, FindOptions } from 'sequelize';
import { Post } from './post';

export interface CategoryAttributes {
	id: number
	name: string
}

export interface Category extends Sequelize.Instance<CategoryAttributes>, CategoryAttributes {
	getPosts: (options?: FindOptions<Post>) => Promise<Post[]>
	setPosts: (posts: Post[]) => Promise<void>
	addPost: (post: Post) => Promise<void>
	addPosts: (posts: Post[]) => Promise<void>
}

export default (
	sequelize: Sequelize.Sequelize,
	tableOptions?: DefineOptions<Category>
): Sequelize.Model<Category, CategoryAttributes> => {
	const DataTypes: DataTypes = sequelize.Sequelize;

	tableOptions = tableOptions || {};
	tableOptions.freezeTableName = true;
	tableOptions.tableName = 'category';

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

	return sequelize.define<Category, CategoryAttributes>(
		'Category',
		columns,
		tableOptions
	);
};
